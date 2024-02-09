var net = require('net');
var events = require('events');
var { Worker } = require('worker_threads');
var path = require('path');
const JobManager = require('./jobManager.js');

//Gives us global access to everything we need for each hashing algorithm
require('./algoProperties.js');

var pool = require('./pool.js');

exports.daemon = require('./daemon.js');
exports.varDiff = require('./varDiff.js');

function startBlockMonitoringWorker() {
    const workerPath = path.resolve(__dirname, './blockMonitorWorker.js');
    const worker = new Worker(workerPath);
    
    // Listen for errors and exit events from the worker
    worker.on('error', console.error);
    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
        }
    });
}

exports.createPool = function (poolOptions, authorizeFn) {
    var newPool = new pool(poolOptions, authorizeFn);
    return newPool;
};

// Start the block monitoring worker
startBlockMonitoringWorker();
