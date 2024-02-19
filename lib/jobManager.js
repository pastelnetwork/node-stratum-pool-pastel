var events = require("events");
var crypto = require("crypto");

var bignum = require("bignum");

var util = require("./util.js");
var { BlockTemplate, validateShareAsync } = require("./blockTemplate.js");
const { createClient } = require("redis");

// Initialize Redis client with specific connection options
const redisClient = createClient({
  url: "redis://localhost:6379", // Specify custom Redis instance URL and port
});

// Function to ensure connection to Redis
async function connectRedis() {
  try {
    if (
      redisClient.status === "connecting" ||
      redisClient.status === "connect"
    ) {
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

const EH_PARAMS_MAP = {
  "125_4": {
    SOLUTION_LENGTH: 106,
    SOLUTION_SLICE: 2,
  },
  "144_5": {
    SOLUTION_LENGTH: 202,
    SOLUTION_SLICE: 2,
  },
  "192_7": {
    SOLUTION_LENGTH: 806,
    SOLUTION_SLICE: 6,
  },
  "200_9": {
    SOLUTION_LENGTH: 2694,
    SOLUTION_SLICE: 6,
  },
};

//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
  var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
  var counter = instanceId << 27;
  this.next = function () {
    var extraNonce = util.packUInt32BE(Math.abs(counter++));
    return extraNonce.toString("hex");
  };
  this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
  var counter = 0x0000cccc;

  this.next = function () {
    counter++;
    if (counter % 0xffffffffff === 0) counter = 1;
    return this.cur();
  };

  this.cur = function () {
    return counter.toString(16);
  };
};
function isHexString(s) {
  var check = String(s).toLowerCase();
  if (check.length % 2) {
    return false;
  }
  for (i = 0; i < check.length; i = i + 2) {
    var c = check[i] + check[i + 1];
    if (!isHex(c)) return false;
  }
  return true;
}
function isHex(c) {
  var a = parseInt(c, 16);
  var b = a.toString(16).toLowerCase();
  if (b.length % 2) {
    b = "0" + b;
  }
  if (b !== c) {
    return false;
  }
  return true;
}

function generateShareId(shareData) {
  // Create a string representation of the share data
  var shareString = `${shareData.jobId}-${shareData.nTime}-${shareData.nonce}-${shareData.workerName}`;
  // Use a hash function to generate a unique ID
  return crypto.createHash("sha256").update(shareString).digest("hex");
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = (module.exports = function JobManager(options) {
  //private members

  var _this = this;
  var jobCounter = new JobCounter();

  var shareMultiplier = algos[options.coin.algorithm].multiplier;

  //public members

  this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

  this.currentJob;
  this.validJobs = {};

  var hashDigest = algos[options.coin.algorithm].hash(options.coin);

  var coinbaseHasher = (function () {
    switch (options.coin.algorithm) {
      default:
        return util.sha256d;
    }
  })();

  var blockHasher = (function () {
    switch (options.coin.algorithm) {
      case "sha1":
        return function (d) {
          return util.reverseBuffer(util.sha256d(d));
        };
      default:
        return function (d) {
          return util.reverseBuffer(util.sha256(d));
        };
    }
  })();

  this.updateCurrentJob = async function (rpcData) {
    var tmpBlockTemplate = new BlockTemplate(
      jobCounter.next(),
      rpcData,
      options.recipients,
      options.address,
      options.poolHex,
      options.coin,
      options.daemon
    );
    if (
      rpcData.version == 3 &&
      (options.coin.symbol == "zen" || options.coin.symbol == "zent")
    ) {
      await tmpBlockTemplate.calculateTrees();
    }

    _this.currentJob = tmpBlockTemplate;

    _this.emit("updatedBlock", tmpBlockTemplate, true);

    _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
  };

  //returns true if processed a new block
  this.processTemplate = async function (rpcData) {
    /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
         block height is greater than the one we have */
    var isNewBlock = typeof _this.currentJob === "undefined";
    if (
      !isNewBlock &&
      _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash
    ) {
      isNewBlock = true;

      //If new block is outdated/out-of-sync than return
      if (rpcData.height < _this.currentJob.rpcData.height) return false;
    }

    if (!isNewBlock) return false;

    var tmpBlockTemplate = new BlockTemplate(
      jobCounter.next(),
      rpcData,
      options.recipients,
      options.address,
      options.poolHex,
      options.coin,
      options.daemon
    );
    if (
      rpcData.version == 3 &&
      (options.coin.symbol == "zen" || options.coin.symbol == "zent")
    ) {
      await tmpBlockTemplate.calculateTrees();
    }

    this.currentJob = tmpBlockTemplate;

    this.validJobs = {};
    _this.emit("newBlock", tmpBlockTemplate);

    this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    return true;
  };

  async function registerWorkerIfNotExists(pslAddress, initialWorkerData) {
    const key = `worker:data:${pslAddress}`;
    const exists = await redisClient.exists(key);
    if (exists === 0) {
      // If the key does not exist
      await redisClient.set(key, JSON.stringify(initialWorkerData));
      console.log(`Registered new worker and set data for ${pslAddress}`);
    }
  }

  this.processShare = async function (
    jobId,
    previousDifficulty,
    difficulty,
    extraNonce1,
    extraNonce2,
    nTime,
    nonce,
    ipAddress,
    port,
    workerName,
    workerPassword,
    soln
  ) {
    // Extract the PSL address and remote IP from workerName
    const [workerPasswordClean, remoteAPIValidatorIp] =
      workerPassword.split("|"); // workerName is in the format: <pslAddress>|<remoteIp>

    const authToken = workerPasswordClean; // We are reusing the workerPassword field for the authToken
    const pslAddress = workerName.split(".")[0]; // Extract the PSL address from the workerName

    // Ensure worker is registered before processing share
    await registerWorkerIfNotExists(pslAddress, {
      remote_ip: remoteAPIValidatorIp,
      authToken: authToken,
    }); // Register the worker if it does not exist

    // Fetch worker data from Redis using pslAddress as the key
    const workerDataString = await redisClient.get(`worker:data:${pslAddress}`);
    const workerData = JSON.parse(workerDataString) || {};

    let canAcceptShares = workerData.can_accept_mining_workers_shares_currently;

    if (!canAcceptShares) {
      console.log(`Worker ${pslAddress} cannot accept shares currently.`);
      return { error: "Worker cannot accept shares", result: null };
    }

    const bestBlockMerkleRoot = workerData
      ? workerData.best_block_merkle_root
      : null;

    if (!bestBlockMerkleRoot) {
      // Handle the case where the merkle root is not available
      console.error(`Merkle root not available for worker ${pslAddress}`);
      return; // Or handle this scenario appropriately
    }

    var shareError = function (error) {
      _this.emit("share", {
        job: jobId,
        ip: ipAddress,
        worker: pslAddress,
        difficulty: difficulty,
        error: error[1],
      });
      return { error: error, result: null };
    };

    console.log(
      "\n\nProcessing Share Details:\n" +
        "  - Job ID: " +
        jobId +
        "\n" +
        "  - Previous Difficulty: " +
        previousDifficulty +
        "\n" +
        "  - Current Difficulty: " +
        difficulty +
        "\n" +
        "  - Extra Nonce 1: " +
        extraNonce1 +
        "\n" +
        "  - Extra Nonce 2: " +
        extraNonce2 +
        "\n" +
        "  - nTime: " +
        nTime +
        "\n" +
        "  - Nonce: " +
        nonce +
        " (The nonce found by the mining worker)\n" +
        "  - IP Address: " +
        ipAddress +
        "\n" +
        "  - Originally Submitted Worker PW: " +
        workerPassword +
        "\n" +
        "  - Remote Validator IP: " +
        remoteAPIValidatorIp +
        "\n" +
        "  - Remote Validator Auth Token: " +
        authToken +
        "\n" +
        "  - Port: " +
        port +
        "\n" +
        "  - PSL Address: " +
        pslAddress +
        " (The mining worker address that is credited with this share)\n" +
        "  - Solution: " + soln
    );

    var submitTime = (Date.now() / 1000) | 0;

    var job = this.validJobs[jobId];

    if (typeof job === "undefined" || job.jobId != jobId) {
      // console.log('job not found');
      return shareError([21, "job not found"]);
    }

    if (nTime.length !== 8) {
      // console.log('incorrect size of ntime');
      return shareError([20, "incorrect size of ntime"]);
    }

    let nTimeInt = parseInt(
      nTime.substr(6, 2) +
        nTime.substr(4, 2) +
        nTime.substr(2, 2) +
        nTime.substr(0, 2),
      16
    );

    if (Number.isNaN(nTimeInt)) {
      // console.log('Invalid nTime: ', nTimeInt, nTime)
      return shareError([20, "invalid ntime"]);
    }

    if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
      // console.log('ntime out of range !(', submitTime + 7200, '<', nTimeInt, '<', job.rpcData.curtime, ') original: ', nTime)
      return shareError([20, "ntime out of range"]);
    }

    if (nonce.length !== 64) {
      // console.log('incorrect size of nonce');
      return shareError([20, "incorrect size of nonce"]);
    }

    /**
     * TODO: This is currently accounting only for equihash. make it smarter.
     */
    let parameters = options.coin.parameters;
    if (!parameters) {
      parameters = {
        N: 200,
        K: 9,
        personalization: "ZcashPoW",
      };
    }

    let N = parameters.N || 200;
    let K = parameters.K || 9;
    let expectedLength = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_LENGTH || 2694;
    let solutionSlice = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_SLICE || 0;

    if (soln.length !== expectedLength) {
      // console.log('Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedLength);
      return shareError([
        20,
        "Error: Incorrect size of solution (" +
          soln.length +
          "), expected " +
          expectedLength,
      ]);
    }

    if (!isHexString(extraNonce2)) {
      // console.log('invalid hex in extraNonce2');
      return shareError([20, "invalid hex in extraNonce2"]);
    }

    if (!job.registerSubmit(nonce, soln)) {
      return shareError([22, "duplicate share"]);
    }

    //console.log('processShare ck5')

    // Fetch worker data from Redis using pslAddress as the key
    const refreshedWorkerDataString = await redisClient.get(`worker:data:${pslAddress}`);
    const refreshedWorkerData = JSON.parse(refreshedWorkerDataString) || {};

    // Serialize the header data (returns v4 (without nonce and solution) and v5 (pastelid & signature) header buffers))
    const headerDataParts = await job.serializeHeaderData(nTime, refreshedWorkerData);
    const headerSolnBuffer = await job.serializeBlockHeader(headerDataParts, nonce, soln);
    const equihashInput = await job.serializeEquihashInput(headerDataParts, nonce, soln);

    var headerHash;

    //console.log('processShare ck6')

    switch (options.coin.algorithm) {
      default:
        //console.log('processShare ck6b')
        headerHash = util.sha256d(headerSolnBuffer);
        break;
    }

    //console.log('processShare ck7')

    var headerBigNum = bignum.fromBuffer(headerHash, {
      endian: "little",
      size: 32,
    });

    var blockHashInvalid;
    var blockHash;
    var blockHex;

    var shareDiff = (diff1 / headerBigNum.toNumber()) * shareMultiplier;
    var blockDiffAdjusted = job.difficulty * shareMultiplier;

    //console.log('processShare ck8')

    // check if valid solution
    if (
      hashDigest(
        equihashInput,
        // Buffer.from(soln, "hex")
        Buffer.from(soln.slice(solutionSlice), "hex")
      ) !== true
    ) {
      //console.log('invalid solution');
      return shareError([20, "invalid solution"]);
    }

    //check if block candidate
    if (headerBigNum.le(job.target)) {
      //console.log('begin serialization');
      blockHex = await job.serializeBlock(headerSolnBuffer).toString("hex");
      blockHash = util.reverseBuffer(headerHash).toString("hex");
      //console.log('end serialization');
    } else {
      //console.log('low difficulty share');
      if (options.emitInvalidBlockHashes)
        blockHashInvalid = util
          .reverseBuffer(util.sha256d(headerSolnBuffer))
          .toString("hex");

      //Check if share didn't reached the miner's difficulty)
      if (shareDiff / difficulty < 0.00001) {
        //Check if share matched a previous difficulty from before a vardiff retarget
        if (previousDifficulty && shareDiff >= previousDifficulty) {
          difficulty = previousDifficulty;
        } else {
          return shareError([23, "low difficulty share of " + shareDiff]);
        }
      }
    }

    // Store the share in Redis and trigger asynchronous validation; obviously there are some redundant fields here,
    // but keeping the names exactly the same as the old code will make it easier to map these fields to the expected names in the old code:
    var shareData = {
      jobId, // Original field
      previousDifficulty,
      difficulty,
      extraNonce1,
      extraNonce2,
      nTime,
      nonce,
      ipAddress, // Original field
      port,
      pslAddress, // Original field
      remoteAPIValidatorIp,
      authToken,
      soln,
      bestBlockMerkleRoot,
      status: "pending",
      // Redundant fields for easier mapping
      ip: ipAddress, // Redundant field
      shareDiff: shareDiff.toFixed(8),
      worker: pslAddress, // Redundant field
      job: jobId, // Redundant field
      height: job.rpcData.height,
      blockReward: job.rpcData.reward,
      blockDiff: blockDiffAdjusted,
      blockDiffActual: job.difficulty,
      blockHash: blockHash,
      blockHashInvalid: blockHashInvalid,
      blockHex: blockHex,
    };

    const shareId = generateShareId(shareData); // Generate a unique ID for the share
    
    // The share event will now be emitted in the validateShareAsync function if the share is valid
    await validateShareAsync(shareData, shareId, _this); // Pass the context (_this) if necessary

    // Return the result indicating that processing is in progress
    return { result: "processing", error: null };
  };
});
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
