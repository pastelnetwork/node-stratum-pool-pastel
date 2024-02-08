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

let global_worker_dict = {}; // Initialize with the actual state if available

function startBlockMonitoringWorker() {
    const workerPath = path.resolve(__dirname, 'path/to/blockMonitorWorker.js');
    const worker = new Worker(workerPath, {
        workerData: {
            global_worker_dict: global_worker_dict
        }
    });

    worker.on('message', (message) => {
        if (message.type === 'update') {
            const { workerId, update } = message.data;
            global_worker_dict[workerId] = update; // Update the main thread's global_worker_dict
            JobManager.updateWorkerData(workerId, update); // Update the worker's data in the JobManager
            console.log(`Updated global_worker_dict for worker ${workerId}`);
        }
    });

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

// Add this line at the end of the file or after all initialization is done
startBlockMonitoringWorker();
