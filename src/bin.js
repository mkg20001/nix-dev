#!/usr/bin/env node

'use strict'

const mkdirp = require('mkdirp').sync
const rimraf = require('rimraf').sync
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const bl = require('bl')

const HOME = process.env.HOME
const CACHE = path.join(HOME, '.cache', 'dev')
const CONFIG = path.join(HOME, '.config', 'dev')

const debug = require('debug')
const log = debug('nix-dev')

mkdirp(CACHE)
mkdirp(CONFIG)

const spawn = (cmd, args, catchStdio, channels, ignoreFail) => new Promise((resolve, reject) => {
  const opt = [cmd, args, { stdio: catchStdio ? 'pipe' : 'inherit', env: { NIX_PATH: channels ? channels.getNixPath() : process.env.NIX_PATH, PATH: process.env.PATH, HOME: process.env.HOME } }]
  log('spawn %o', opt)
  const p = cp.spawn(...opt)

  if (catchStdio) {
    p.stdout = p.stdout.pipe(bl())
    p.stderr = p.stderr.pipe(bl())
  }

  p.once('exit', (code, sig) => {
    if ((code || sig) && !ignoreFail) {
      return reject(new Error(`Failed with ${code || sig}`))
    }

    return resolve({ stdout: String(p.stdout), stderr: String(p.stderr), code, sig })
  })
})

async function checkIfPackageExists (attr, channels) {
  if (attr.indexOf('.') === -1) { // no channel
    return false
  }

  const [channel, ...channelAttr] = attr.split('.')

  const res = await spawn('nix', ['eval', `(let ch = (import <${channel}> {}); in ch ? ${channelAttr.map(JSON.stringify).join('.')})`], true, channels, true)

  if (res.code || res.sig) {
    throw new Error(`nix: ${res.stderr.trim()}`)
  }

  return JSON.parse(res.stdout.trim() || 'false')
}

async function resolveChannel (channelName) {
  const res = await spawn('nix', ['eval', '--raw', `(<${channelName}>)`], true)
  const p = res.stdout.trim()

  if (!p.startsWith('/')) {
    throw new Error('nix: ' + res.stderr.trim())
  }

  return p
}

function generateNix (name, storage, channels) {
  return `{ pkgs ? import <nixpkgs> {} }:

# TODO: load channels

let
  ${channels.list().map(channel => `${channel} = import <${channel}> {};`).join('\n  ')}
in
(pkgs.buildFHSUserEnv {
  name = "dev-${name}";
  extraOutputsToInstall = ["include" "dev"]; # TODO: make it saner?

  targetPkgs = pkgs: with pkgs; [
    ${storage.value.join('\n  ')}
  ];

  multiPkgs = pkgs: with pkgs; [
  ];

  runScript = ''$SHELL'';
})`
}

function Storage (env) {
  let cache = []
  const diskPath = path.join(CONFIG, `env.${env}`)
  const isNew = !fs.existsSync(diskPath)

  log(`s#${env}: init storage for ${env}, %o new=%o`, diskPath, isNew)

  function read () {
    log(`s#${env}: reading`)
    cache = fs.existsSync(diskPath) ? String(fs.readFileSync(diskPath)).split('\n').filter(v => Boolean(v)) : []
  }

  function write () {
    log(`s#${env}: writing`)
    fs.writeFileSync(diskPath, cache.join('\n'))
  }

  read()

  return {
    get value () {
      return cache
    },
    set value (value) {
      cache = value
    },
    read,
    write,
    isNew
  }
}

function Channels (env) {
  const diskPath = path.join(CACHE, env, 'channels')
  mkdirp(diskPath)

  log(`c#${env}: init channels %o`, diskPath)

  return {
    has: name => {
      log(`c#${env}: has ${name}`)
      return fs.existsSync(path.join(diskPath, name))
    },
    update: async name => {
      log(`c#${env}: update ${name}`)
      const channel = await resolveChannel(name)
      rimraf(path.join(diskPath, name))
      await spawn('nix-store', ['--realise', channel, '--indirect', '--add-root', path.join(diskPath, name)], true)
    },
    remove: name => {
      log(`c#${env}: remove ${name}`)
      rimraf(path.join(diskPath, name))
    },
    getNixPath: () => {
      log(`c#${env}: get nix path`)
      return fs.readdirSync(diskPath).map(channel => {
        return `${channel}=${diskPath}/${channel}`
      }).join(':')
    },
    list: () => {
      log(`c#${env}: list`)
      return fs.readdirSync(diskPath)
    }
  }
}

async function rebuild (env, storage, channels) {
  const diskPath = path.join(CACHE, env, 'default.nix')

  log(`${env}: generating nix`)
  fs.writeFileSync(diskPath, generateNix(env, storage, channels))

  log(`${env}: rebuilding`)
  console.log('rebuilding %s...', env)
  await spawn('nix-build', [diskPath, '-o', path.join(CACHE, env, 'result')], false, channels)
}

async function routineStuff (env, storage, channels) {
  if (!channels.has('nixpkgs')) {
    await channels.update('nixpkgs') // we kinda need it for buildFHSUserEnv :P
  }

  const seen = {}
  const shouldHave = storage.value.map(v => v.split('.')[0]).filter(v => seen[v] ? false : (seen[v] = true))
  shouldHave.push('nixpkgs')

  channels.list().filter(channel => shouldHave.indexOf(channel) === -1).forEach(channel => {
    log(`${env}: GC channel ${channel}`)
    channels.remove(channel)
  })
}

function envNotFound (env) {
  console.error('Environment does not exist, please create it by adding packages')
  console.error(` $ dev add${env === 'default' ? '' : ' -e ' + env} <package>`)
  process.exit(1)
}

require('yargs') // eslint-disable-line
  .scriptName('dev')
  .command('add [pkgs..]', 'add one or more packages', yargs => yargs, async argv => {
    const pkgs = argv.pkgs
    const env = argv.e
    const storage = Storage(env)
    const channels = Channels(env)

    log(`${env}: adding pkgs...`)

    await routineStuff(env, storage, channels)

    let hadErrors = true

    for (let i = 0; i < pkgs.length; i++) {
      let pkg = pkgs[i]

      try {
        if (!await checkIfPackageExists(pkg)) {
          log(`${env}@${pkg}: wasnt found, try prefix`)
          if (!await checkIfPackageExists(`nixpkgs.${pkg}`)) {
            log(`${env}@${pkg}: giving up`)
            console.warn(`${pkg}: does not exist or fails to evaluate`)
            hadErrors = true
            continue
          } else {
            log(`${env}@${pkg}: prefixed!`)
            pkg = `nixpkgs.${pkg}`
          }
        }

        const [channel] = pkg.split('.')

        if (!channels.has(channel)) {
          log(`${env}@${pkg}: requires <${channel}> but not already added, adding now`)
          await channels.update(channel)
        }

        if (storage.value.indexOf(pkg) === -1) {
          log(`${env}@${pkg}: storing..`)
          storage.value.push(pkg)
          storage.value = storage.value.sort()
        }
      } catch (error) {
        console.error(`${pkg}: ${String(error)}`)
        hadErrors = true
      }

      log(`${env}: writing storage...`)
      storage.write()

      if (argv.r) {
        await rebuild(env, storage, channels)
      }
    }

    process.exit(hadErrors ? 1 : 0)
  })
  .command('rm [pkgs..]', 'remove one or more packages', yargs => yargs, async argv => {
    const pkgs = argv.pkgs
    const env = argv.e
    const storage = Storage(env)
    const channels = Channels(env)

    log(`${env}: adding pkgs...`)

    let hadErrors = true

    for (let i = 0; i < pkgs.length; i++) {
      let pkg = pkgs[i]

      try {
        if (storage.value.indexOf(pkg) !== -1) {
          log(`${env}@${pkg}: wasnt found, try prefix`)
          if (storage.value.indexOf(`nixpkgs.${pkg}`) !== -1) {
            log(`${env}@${pkg}: giving up`)
            console.log(`${pkg}: not installed`)
            continue
          } else {
            log(`${env}@${pkg}: prefixed!`)
            pkg = `nixpkgs.${pkg}`
          }
        }

        storage.value = storage.value.filter(curPkg => curPkg !== pkg)
      } catch (error) {
        console.error(`${pkg}: ${String(error)}`)
        hadErrors = true
      }

      await routineStuff(env, storage, channels)

      log(`${env}: writing storage...`)
      storage.write()

      if (argv.r) {
        await rebuild(env, storage, channels)
      }
    }

    process.exit(hadErrors ? 1 : 0)
  })
  .command('rebuild [env]', 'rebuild an environment', yargs => yargs, async argv => {
    const env = argv.e
    const storage = Storage(env)
    const channels = Channels(env)

    if (storage.isNew) {
      return envNotFound(env)
    }

    await routineStuff(env, storage, channels)
    await rebuild(env, storage, channels)
  })
  .command('update [env]', 'update an environment', yargs => yargs.options('fetch', {
    type: 'boolean',
    alias: 'f',
    description: 'Fetch channels before updating',
    default: false
  }), async argv => {
    const env = argv.e
    const storage = Storage(env)
    const channels = Channels(env)

    if (storage.isNew) {
      return envNotFound(env)
    }

    await routineStuff(env, storage, channels)

    if (argv.fetch) {
      await spawn('nix-channel', ['--update', '-vv'], false)
    }

    await Promise.all(channels.list().map(channel => channels.update(channel)))

    if (argv.r) {
      await rebuild(env, storage, channels)
    }
  })
  .command(['enter [env]', '$0'], 'enter an environment', yargs => yargs, async argv => {
    const env = argv.e
    const storage = Storage(env)
    const channels = Channels(env)

    if (storage.isNew) {
      return envNotFound(env)
    }

    const bin = path.join(CACHE, env, 'result', 'bin', `dev-${env}`)

    if (!fs.existsSync(bin)) {
      if (!argv.r) {
        console.error('Environment needs rebuild, auto-rebuild disabled')
        console.error(` $ dev rebuild${env === 'default' ? '' : ' -e ' + env}`)
        process.exit(1)
      }

      await routineStuff(env, storage, channels)
      await rebuild(env, storage, channels)
    }

    cp.spawn(bin, [], {
      stdio: 'inherit',
      env: Object.assign({
        NIX_PATH: channels.getNixPath(),
        NIX_DEV: env
      }, process.env)
    })
  })
  .options('env', {
    alias: 'e',
    type: 'string',
    description: 'Environment to use',
    default: 'default'
  })
  .options('rebuild', {
    alias: 'r',
    type: 'boolean',
    description: 'Rebuild automatically (disable: --no-rebuild)',
    default: true
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging'
  })
  .help()
  .argv
