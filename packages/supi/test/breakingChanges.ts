import { WANTED_SHRINKWRAP_FILENAME } from '@pnpm/constants'
import prepare from '@pnpm/prepare'
import isCI = require('is-ci')
import mkdirp = require('mkdirp-promise')
import fs = require('mz/fs')
import { addDependenciesToPackage, install } from 'supi'
import tape = require('tape')
import promisifyTape from 'tape-promise'
import { testDefaults } from './utils'

const test = promisifyTape(tape)
const testOnly = promisifyTape(tape.only)

test('fail on non-compatible node_modules', async (t: tape.Test) => {
  const project = prepare(t)
  const opts = await testDefaults()

  await saveModulesYaml('0.50.0', opts.store)

  try {
    await addDependenciesToPackage(['is-negative'], opts)
    t.fail('should have failed')
  } catch (err) {
    t.equal(err.code, 'MODULES_BREAKING_CHANGE', 'modules breaking change error is thrown')
  }
})

test("don't fail on non-compatible node_modules when forced", async (t: tape.Test) => {
  const project = prepare(t)
  const opts = await testDefaults({ force: true })

  await saveModulesYaml('0.50.0', opts.store)

  await install(opts)

  t.pass('install did not fail')
})

test('do not fail on non-compatible node_modules when forced with a named installation', async (t: tape.Test) => {
  const project = prepare(t)
  const opts = await testDefaults({ force: true })

  await saveModulesYaml('0.50.0', opts.store)

  await addDependenciesToPackage(['is-negative'], opts)
})

test("don't fail on non-compatible store when forced", async (t: tape.Test) => {
  const project = prepare(t)
  const opts = await testDefaults({ force: true })

  await saveModulesYaml('0.32.0', opts.store)

  await install(opts)

  t.pass('install did not fail')
})

test('do not fail on non-compatible store when forced during named installation', async (t: tape.Test) => {
  const project = prepare(t)
  const opts = await testDefaults({ force: true })

  await saveModulesYaml('0.32.0', opts.store)

  await addDependenciesToPackage(['is-negative'], opts)
})

async function saveModulesYaml (pnpmVersion: string, storePath: string) {
  await mkdirp('node_modules')
  await fs.writeFile('node_modules/.modules.yaml', `packageManager: pnpm@${pnpmVersion}\nstore: ${storePath}\nindependentLeaves: false`)
}

test(`fail on non-compatible ${WANTED_SHRINKWRAP_FILENAME}`, async (t: tape.Test) => {
  if (isCI) {
    t.skip('this test will always fail on CI servers')
    return
  }

  const project = prepare(t)
  await fs.writeFile(WANTED_SHRINKWRAP_FILENAME, '')

  try {
    await addDependenciesToPackage(['is-negative'], await testDefaults())
    t.fail('should have failed')
  } catch (err) {
    t.equal(err.code, 'SHRINKWRAP_BREAKING_CHANGE', 'shrinkwrap breaking change error is thrown')
  }
})

test(`don't fail on non-compatible ${WANTED_SHRINKWRAP_FILENAME} when forced`, async (t: tape.Test) => {
  const project = prepare(t)
  await fs.writeFile(WANTED_SHRINKWRAP_FILENAME, '')

  await addDependenciesToPackage(['is-negative'], await testDefaults({ force: true }))

  t.pass('install did not fail')
})
