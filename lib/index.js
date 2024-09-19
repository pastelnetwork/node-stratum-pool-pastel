// index.js

const net = require("net");
const events = require("events");
const { Worker } = require("worker_threads");
const path = require("path");

// Requires the pool module just like the older version
const pool = require("./pool.js");
const Redis = require("./redisClient.js");

let isBlockMonitoringWorkerStarted = false;
let blockMonitoringWorker = null;

// Assuming daemon.js and varDiff.js are still relevant and correctly located
exports.daemon = require("./daemon.js");
exports.varDiff = require("./varDiff.js");

// No changes needed here based on the older version
exports.createPool = function (poolOptions, authorizeFn) {
  var newPool = new pool(poolOptions, authorizeFn);
  return newPool;
};

// this is executed from the main process only once
exports.startBlockMonitoringWorker = function (poolConfigs) {
  if (isBlockMonitoringWorkerStarted) {
    console.log("Block monitor worker already started.");
    return;
  }
  isBlockMonitoringWorkerStarted = true;
  console.log("Starting block monitor worker...");

  try {
    let coinDaemonDirectory = null;
    if (poolConfigs && typeof poolConfigs === "object") {
      let keys = Object.keys(poolConfigs);
      if (keys.length > 0) {
        coinDaemonDirectory = poolConfigs[keys[0]].coinDaemonDirectory;
      }
    }

    const workerPath = path.resolve(__dirname, "./blockMonitorWorker.js");
    blockMonitoringWorker = new Worker(workerPath, {
      workerData: { coinDaemonDirectory: coinDaemonDirectory },
    });

    blockMonitoringWorker.on("error", console.error);
    blockMonitoringWorker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
      }
    });

    console.log("Block monitor worker started.");
  } catch (error) {
    console.error("Error starting block monitor worker:", error);
  }
};

exports.stopBlockMonitoringWorker = function () {
  if (!isBlockMonitoringWorkerStarted) {
    console.log("Block monitor worker not started.");
    return;
  }

  console.log("Stopping block monitor worker...");

  blockMonitoringWorker.terminate();
  blockMonitoringWorker = null;
  isBlockMonitoringWorkerStarted = false;

  console.log("Block monitor worker stopped.");
}


