var net = require('net');
var events = require('events');
var { Worker } = require('worker_threads');
var path = require('path');
const { createClient } = require("redis");

// Initialize Redis client with specific connection options
const redisClient = createClient({
  url: "redis://localhost:6379", // Specify custom Redis instance URL and port
});

// Function to ensure connection to Redis
async function connectRedis() {
  try {
    if (redisClient.status === "connecting" || redisClient.status === "connect") {
        console.log("Redis client is already connecting or connected.");
    } else {
        redisClient.connect().catch(console.error);
    }

    console.log("Connected to Redis successfully.");
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    // Optionally, implement retry logic or error handling here
  }
}

// Call connectRedis to establish the connection
connectRedis();

// Requires the pool module just like the older version
var pool = require('./pool.js');

// Assuming daemon.js and varDiff.js are still relevant and correctly located
exports.daemon = require('./daemon.js');
exports.varDiff = require('./varDiff.js');

// No changes needed here based on the older version
exports.createPool = function (poolOptions, authorizeFn) {
    var newPool = new pool(poolOptions, authorizeFn);
    return newPool;
};

async function startBlockMonitoringWorker() {
    // Define a lock key to prevent multiple workers from running simultaneously
    const lockKey = 'blockMonitorWorker:lock';
    // Use async/await for Redis operations
    const lockValue = await redisClient.get(lockKey);
    if (lockValue) {
        console.log('Block monitor worker already running in another process.');
        return;
    }

    try {
        // Use SET command directly to utilize NX and EX options atomically
        const setResult = await redisClient.set(lockKey, 'true', {
            EX: 60, // Expire the lock after 60 seconds
            NX: true // Set only if the key does not exist
        });

        if (setResult !== 'OK') {
            console.log('Block monitor worker already running in another process.');
            return;
        }

        const workerPath = path.resolve(__dirname, './blockMonitorWorker.js');
        const worker = new Worker(workerPath);

        worker.on('error', console.error);
        worker.on('exit', async (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
            // Remove the lock when the worker exits
            await redisClient.del(lockKey);
        });

        console.log('Block monitor worker started.');
    } catch (error) {
        console.error('Error starting block monitor worker:', error);
    }
}

// Start the block monitoring worker
startBlockMonitoringWorker();
