import {
  ENGINE_NAME,
  LAYOUT_VERSION,
  WANTED_SHRINKWRAP_FILENAME,
} from '@pnpm/constants'
import { skippedOptionalDependencyLogger } from '@pnpm/core-loggers'
import {
  runLifecycleHooksConcurrently,
  runPostinstallHooks,
} from '@pnpm/lifecycle'
import logger, { streamParser } from '@pnpm/logger'
import { write as writeModulesYaml } from '@pnpm/modules-yaml'
import pkgIdToFilename from '@pnpm/pkgid-to-filename'
import {
  nameVerFromPkgSnapshot,
  packageIsIndependent,
  PackageSnapshots,
  Shrinkwrap,
} from '@pnpm/shrinkwrap-utils'
import npa = require('@zkochan/npm-package-arg')
import * as dp from 'dependency-path'
import graphSequencer = require('graph-sequencer')
import path = require('path')
import R = require('ramda')
import runGroups from 'run-groups'
import semver = require('semver')
import getContext from '../getContext'
import extendOptions, {
  RebuildOptions,
  StrictRebuildOptions,
} from './extendRebuildOptions'

function findPackages (
  packages: PackageSnapshots,
  searched: PackageSelector[],
  opts: {
    prefix: string,
  },
): string[] {
  return R.keys(packages)
    .filter((relativeDepPath) => {
      const pkgShr = packages[relativeDepPath]
      const pkgInfo = nameVerFromPkgSnapshot(relativeDepPath, pkgShr)
      if (!pkgInfo.name) {
        logger.warn({
          message: `Skipping ${relativeDepPath} because cannot get the package name from ${WANTED_SHRINKWRAP_FILENAME}.
            Try to run run \`pnpm update --depth 100\` to create a new ${WANTED_SHRINKWRAP_FILENAME} with all the necessary info.`,
          prefix: opts.prefix,
        })
        return false
      }
      return matches(searched, pkgInfo)
    })
}

// TODO: move this logic to separate package as this is also used in dependencies-hierarchy
function matches (
  searched: PackageSelector[],
  pkg: {name: string, version?: string},
) {
  return searched.some((searchedPkg) => {
    if (typeof searchedPkg === 'string') {
      return pkg.name === searchedPkg
    }
    return searchedPkg.name === pkg.name && !!pkg.version &&
      semver.satisfies(pkg.version, searchedPkg.range)
  })
}

type PackageSelector = string | {
  name: string,
  range: string,
}

export async function rebuildPkgs (
  importers: Array<{ prefix: string }>,
  pkgSpecs: string[],
  maybeOpts: RebuildOptions,
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const ctx = await getContext(importers, opts)

  if (!ctx.currentShrinkwrap || !ctx.currentShrinkwrap.packages) return
  const packages = ctx.currentShrinkwrap.packages

  const searched: PackageSelector[] = pkgSpecs.map((arg) => {
    const parsed = npa(arg)
    if (parsed.raw === parsed.name) {
      return parsed.name
    }
    if (parsed.type !== 'version' && parsed.type !== 'range') {
      throw new Error(`Invalid argument - ${arg}. Rebuild can only select by version or range`)
    }
    return {
      name: parsed.name,
      range: parsed.fetchSpec,
    }
  })

  let pkgs = [] as string[]
  for (const importer of importers) {
    pkgs = [
      ...pkgs,
      ...findPackages(packages, searched, { prefix: importer.prefix }),
    ]
  }

  await _rebuild(
    new Set(pkgs),
    ctx.virtualStoreDir,
    ctx.currentShrinkwrap,
    ctx.importers.map((importer) => importer.id),
    opts,
  )
}

export async function rebuild (
  importers: Array<{ buildIndex: number, prefix: string }>,
  maybeOpts: RebuildOptions,
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const ctx = await getContext(importers, opts)

  let idsToRebuild: string[] = []

  if (opts.pending) {
    idsToRebuild = ctx.pendingBuilds
  } else if (ctx.currentShrinkwrap && ctx.currentShrinkwrap.packages) {
    idsToRebuild = R.keys(ctx.currentShrinkwrap.packages)
  } else {
    return
  }
  if (idsToRebuild.length === 0) return

  const pkgsThatWereRebuilt = await _rebuild(
    new Set(idsToRebuild),
    ctx.virtualStoreDir,
    ctx.currentShrinkwrap,
    ctx.importers.map((importer) => importer.id),
    opts,
  )

  ctx.pendingBuilds = ctx.pendingBuilds.filter((relDepPath) => !pkgsThatWereRebuilt.has(relDepPath))

  const scriptsOpts = {
    rawNpmConfig: opts.rawNpmConfig,
    unsafePerm: opts.unsafePerm || false,
  }
  await runLifecycleHooksConcurrently(
    ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare'],
    ctx.importers,
    opts.childConcurrency || 5,
    scriptsOpts,
  )
  for (const importer of ctx.importers) {
    if (importer.pkg && importer.pkg.scripts && (!opts.pending || ctx.pendingBuilds.indexOf(importer.id) !== -1)) {
      ctx.pendingBuilds.splice(ctx.pendingBuilds.indexOf(importer.id), 1)
    }
  }

  await writeModulesYaml(ctx.virtualStoreDir, {
    ...ctx.modulesFile,
    importers: {
      ...ctx.modulesFile && ctx.modulesFile.importers,
      ...ctx.importers.reduce((acc, importer) => {
        acc[importer.id] = {
          hoistedAliases: importer.hoistedAliases,
          shamefullyFlatten: importer.shamefullyFlatten,
        }
        return acc
      }, {}),
    },
    included: ctx.include,
    independentLeaves: opts.independentLeaves,
    layoutVersion: LAYOUT_VERSION,
    packageManager: `${opts.packageManager.name}@${opts.packageManager.version}`,
    pendingBuilds: ctx.pendingBuilds,
    registries: ctx.registries,
    skipped: Array.from(ctx.skipped),
    store: ctx.storePath,
  })
}

function getSubgraphToBuild (
  pkgSnapshots: PackageSnapshots,
  entryNodes: string[],
  nodesToBuildAndTransitive: Set<string>,
  walked: Set<string>,
  opts: {
    optional: boolean,
    pkgsToRebuild: Set<string>,
  },
) {
  let currentShouldBeBuilt = false
  for (const depPath of entryNodes) {
    if (nodesToBuildAndTransitive.has(depPath)) {
      currentShouldBeBuilt = true
    }
    if (walked.has(depPath)) continue
    walked.add(depPath)
    const pkgSnapshot = pkgSnapshots[depPath]
    if (!pkgSnapshot) {
      if (depPath.startsWith('link:')) continue

      // It might make sense to fail if the depPath is not in the skipped list from .modules.yaml
      // However, the skipped list currently contains package IDs, not dep paths.
      logger.debug({ message: `No entry for "${depPath}" in ${WANTED_SHRINKWRAP_FILENAME}` })
      continue
    }
    const nextEntryNodes = R.toPairs({
      ...pkgSnapshot.dependencies,
      ...(opts.optional && pkgSnapshot.optionalDependencies || {}),
    })
    .map((pair) => dp.refToRelative(pair[1], pair[0]))
    .filter((nodeId) => nodeId !== null) as string[]

    const childShouldBeBuilt = getSubgraphToBuild(pkgSnapshots, nextEntryNodes, nodesToBuildAndTransitive, walked, opts)
      || opts.pkgsToRebuild.has(depPath)
    if (childShouldBeBuilt) {
      nodesToBuildAndTransitive.add(depPath)
      currentShouldBeBuilt = true
    }
  }
  return currentShouldBeBuilt
}

async function _rebuild (
  pkgsToRebuild: Set<string>,
  modules: string,
  shr: Shrinkwrap,
  importerIds: string[],
  opts: StrictRebuildOptions,
) {
  const pkgsThatWereRebuilt = new Set()
  const graph = new Map()
  const pkgSnapshots: PackageSnapshots = shr.packages || {}

  const entryNodes = [] as string[]

  importerIds.forEach((importerId) => {
    const shrImporter = shr.importers[importerId]
    R.toPairs({
      ...(opts.development && shrImporter.devDependencies || {}),
      ...(opts.production && shrImporter.dependencies || {}),
      ...(opts.optional && shrImporter.optionalDependencies || {}),
    })
    .map((pair) => dp.refToRelative(pair[1], pair[0]))
    .filter((nodeId) => nodeId !== null)
    .forEach((relDepPath) => {
      entryNodes.push(relDepPath as string)
    })
  })

  const nodesToBuildAndTransitive = new Set()
  getSubgraphToBuild(pkgSnapshots, entryNodes, nodesToBuildAndTransitive, new Set(), { optional: opts.optional === true, pkgsToRebuild })
  const nodesToBuildAndTransitiveArray = Array.from(nodesToBuildAndTransitive)

  for (const relDepPath of nodesToBuildAndTransitiveArray) {
    const pkgSnapshot = pkgSnapshots[relDepPath]
    graph.set(relDepPath, R.toPairs({ ...pkgSnapshot.dependencies, ...pkgSnapshot.optionalDependencies })
      .map((pair) => dp.refToRelative(pair[1], pair[0]))
      .filter((childRelDepPath) => nodesToBuildAndTransitive.has(childRelDepPath)))
  }
  const graphSequencerResult = graphSequencer({
    graph,
    groups: [nodesToBuildAndTransitiveArray],
  })
  const chunks = graphSequencerResult.chunks as string[][]

  const groups = chunks.map((chunk) => chunk.filter((relDepPath) => pkgsToRebuild.has(relDepPath)).map((relDepPath) =>
    async () => {
      const pkgSnapshot = pkgSnapshots[relDepPath]
      const depPath = dp.resolve(opts.registries, relDepPath)
      const pkgInfo = nameVerFromPkgSnapshot(relDepPath, pkgSnapshot)
      const independent = opts.independentLeaves && packageIsIndependent(pkgSnapshot)
      const pkgRoot = !independent
        ? path.join(modules, `.${pkgIdToFilename(depPath, opts.shrinkwrapDirectory)}`, 'node_modules', pkgInfo.name)
        : await (
          async () => {
            const { directory } = await opts.storeController.getPackageLocation(pkgSnapshot.id || depPath, pkgInfo.name, {
              shrinkwrapDirectory: opts.shrinkwrapDirectory,
              targetEngine: opts.sideEffectsCacheRead && !opts.force && ENGINE_NAME || undefined,
            })
            return directory
          }
        )()
      try {
        await runPostinstallHooks({
          depPath,
          optional: pkgSnapshot.optional === true,
          pkgRoot,
          prepare: pkgSnapshot.prepare,
          rawNpmConfig: opts.rawNpmConfig,
          rootNodeModulesDir: modules,
          unsafePerm: opts.unsafePerm || false,
        })
        pkgsThatWereRebuilt.add(relDepPath)
      } catch (err) {
        if (pkgSnapshot.optional) {
          // TODO: add parents field to the log
          skippedOptionalDependencyLogger.debug({
            details: err.toString(),
            package: {
              id: pkgSnapshot.id || depPath,
              name: pkgInfo.name,
              version: pkgInfo.version,
            },
            prefix: opts.prefix,
            reason: 'build_failure',
          })
          return
        }
        throw err
      }
    }
  ))

  await runGroups(opts.childConcurrency || 5, groups)

  return pkgsThatWereRebuilt
}
