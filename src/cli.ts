#!/usr/bin/env node
import { main } from "./cli-main.js";

// Only argv and public-RPC overrides from the environment are used. No key file or private key is read.
const code = await main(process.argv.slice(2), {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
});
process.exitCode = code;
