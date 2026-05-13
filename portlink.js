#!/usr/bin/env node
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const chalk = require('chalk');
const ora   = require('ora');

// ─── Logger ──────────────────────────────────────────────────────────────────
function makeLogger(verbose) {
  const ts = () => chalk.gray(new Date().toTimeString().slice(0, 8));
  return {
    info  : (...a) => console.log (`${ts()} ${chalk.cyan('INFO')}  `, ...a),
    warn  : (...a) => console.warn(`${ts()} ${chalk.yellow('WARN')}  `, ...a),
    error : (...a) => console.error(`${ts()} ${chalk.red('ERROR')} `, ...a),
    debug : verbose ? (...a) => console.log(`${ts()} ${chalk.magenta('DEBUG')} `, ...a) : undefined,
  };
}

// ─── ASCII banner ─────────────────────────────────────────────────────────────
function banner() {
  console.log(chalk.bold.cyan(`
  ██████╗  ██████╗ ██████╗ ████████╗██╗     ██╗███╗   ██╗██╗  ██╗
  ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██║     ██║████╗  ██║██║ ██╔╝
  ██████╔╝██║   ██║██████╔╝   ██║   ██║     ██║██╔██╗ ██║█████╔╝ 
  ██╔═══╝ ██║   ██║██╔══██╗   ██║   ██║     ██║██║╚██╗██║██╔═██╗ 
  ██║     ╚██████╔╝██║  ██║   ██║   ███████╗██║██║ ╚████║██║  ██╗
  ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝
  `) + chalk.gray('  Instant localhost port sharing — v1.0.0\n'));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = yargs(hideBin(process.argv))
  .scriptName('portlink')
  .usage('$0 <command> [options]')

  // ── HOST command ──────────────────────────────────────────────────────────
  .command(
    'host [ports..]',
    'Share local ports with joining clients',
    (y) => y
      .positional('ports', {
        describe : 'Ports to share (e.g. 3000 8080)',
        type     : 'number',
        array    : true,
      })
      .option('tunnel-port', {
        alias    : 't',
        describe : 'Port the tunnel server listens on',
        default  : 7700,
        type     : 'number',
      })
      .option('password', {
        alias    : 'p',
        describe : 'Require password from clients',
        type     : 'string',
      })
      .option('cert', {
        describe : 'Path to TLS certificate (PEM)',
        type     : 'string',
      })
      .option('key', {
        describe : 'Path to TLS private key (PEM)',
        type     : 'string',
      })
      .option('verbose', { alias: 'v', type: 'boolean', default: false })
      .example('$0 host 3000 8080', 'Share ports 3000 and 8080')
      .example('$0 host 3000 -p secret', 'Share with password protection')
  )

  // ── JOIN command ──────────────────────────────────────────────────────────
  .command(
    'join <host>',
    'Connect to a host and mirror their ports locally',
    (y) => y
      .positional('host', {
        describe : 'Hostname or IP of the portlink host',
        type     : 'string',
      })
      .option('tunnel-port', {
        alias    : 't',
        describe : 'Tunnel port on the host',
        default  : 7700,
        type     : 'number',
      })
      .option('password', {
        alias    : 'p',
        describe : 'Password (if host requires one)',
        type     : 'string',
      })
      .option('tls', {
        describe : 'Use TLS (wss://)',
        type     : 'boolean',
        default  : false,
      })
      .option('no-verify', {
        describe : 'Skip TLS certificate verification (self-signed)',
        type     : 'boolean',
        default  : false,
      })
      .option('verbose', { alias: 'v', type: 'boolean', default: false })
      .example('$0 join 192.168.1.10', 'Connect to a LAN host')
      .example('$0 join myserver.com -p secret --tls', 'Connect over the internet with TLS')
  )

  .demandCommand(1, 'Specify a command: host or join')
  .strict()
  .help()
  .argv;

// ─── Run ──────────────────────────────────────────────────────────────────────
banner();

const cmd = argv._[0];
const log = makeLogger(argv.verbose);

if (cmd === 'host') {
  const { Host } = require('./lib/host');

  const ports = argv.ports || [];
  if (ports.length === 0) {
    log.error('Specify at least one port to share. Example: portlink host 3000 8080');
    process.exit(1);
  }

  const host = new Host({
    tunnelPort : argv.tunnelPort,
    ports,
    password   : argv.password,
    cert       : argv.cert,
    key        : argv.key,
  });

  log.info(chalk.bold('Mode: HOST'));
  log.info(`Share this command with clients:`);
  console.log(chalk.bold.green(`\n  portlink join <your-ip> --tunnel-port ${argv.tunnelPort}${argv.password ? ' --password ****' : ''}\n`));

  host.start(log);

} else if (cmd === 'join') {
  const { Client } = require('./lib/client');

  const client = new Client({
    host               : argv.host,
    port               : argv.tunnelPort,
    password           : argv.password || '',
    tls                : argv.tls,
    rejectUnauthorized : !argv.noVerify,
  });

  log.info(chalk.bold('Mode: JOIN'));
  log.info(`Connecting to ${argv.host}:${argv.tunnelPort}…`);

  client.start(log);

  process.on('SIGINT',  () => { client.stop(); process.exit(0); });
  process.on('SIGTERM', () => { client.stop(); process.exit(0); });
}
