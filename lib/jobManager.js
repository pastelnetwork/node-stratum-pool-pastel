// jobManager.js

const events = require("events");
const crypto = require("crypto");
const bignum = require("bignum");

const util = require("./util.js");
const { BlockTemplate, validateShareAsync } = require("./blockTemplate.js");
const Redis = require("./redisClient.js");

let g_redisClient = null;

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

    if (!isNewBlock)
      return false;

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
    const exists = await g_redisClient.exists(key);
    if (exists === 0) {
      // If the key does not exist
      await g_redisClient.set(key, JSON.stringify(initialWorkerData));
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
    if (!g_redisClient) {
      g_redisClient = await Redis.checkRedisConnection(g_redisClient);
    }

    // Extract the PSL address and remote IP from workerName and workerPassword
    // workerPassword is in the format: <workerPassword>|<remoteIp>
    const [workerPasswordClean, remoteAPIValidatorIp] = workerPassword.split("|");

    const authToken = workerPasswordClean; // We are reusing the workerPassword field for the authToken
    // workerName is in the format: <pslAddress>.<remoteIp>
    const pslAddress = workerName.split(".")[0]; // Extract the PSL address from the workerName

    // Ensure worker is registered before processing share
    await registerWorkerIfNotExists(pslAddress, {
      remote_ip: remoteAPIValidatorIp,
      authToken: authToken,
    }); // Register the worker if it does not exist

    // Fetch worker data from Redis using pslAddress as the key
    //const workerDataString = await g_redisClient.get(`worker:data:${pslAddress}`);
    //const workerData = JSON.parse(workerDataString) || {};

    //let canAcceptShares = workerData.can_accept_mining_workers_shares_currently;

    //if (!canAcceptShares) {
    //  console.log(`Worker ${pslAddress} cannot accept shares currently.`);
    //  return { error: "Worker cannot accept shares", result: null };
    //}

    //const bestBlockMerkleRoot = workerData
    //  ? workerData.best_block_merkle_root
    //  : null;

    //if (!bestBlockMerkleRoot) {
    // Handle the case where the merkle root is not available
    //  console.error(`Merkle root not available for worker ${pslAddress}`);
    //  return; // Or handle this scenario appropriately
    //}

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

    var job = this.validJobs[jobId];

    if (typeof job === "undefined" || job.jobId != jobId) {
      // console.log('job not found');
      return shareError([21, "job not found"]);
    }

    console.log(
      "\n\nProcessing Share Details:" +
      "\n  - Job ID: " + jobId +
      "\n  - Previous Difficulty: " + previousDifficulty +
      "\n  - Current Difficulty: " + difficulty +
      "\n  - Extra Nonce 1: " + extraNonce1 +
      "\n  - Extra Nonce 2: " + extraNonce2 +
      "\n  - nTime: " + nTime +
      "\n  - Nonce: " + nonce + " (The nonce found by the mining worker)" +
      "\n  - IP Address: " + ipAddress +
      "\n  - Originally Submitted Worker PW: " + workerPassword +
      "\n  - Remote Validator IP: " + remoteAPIValidatorIp +
      "\n  - Remote Validator Auth Token: " +
      authToken +
      "\n  - Port: " + port +
      "\n  - PSL Address: " + pslAddress + " (The mining worker address that is credited with this share)" +
      "\n  - mnid: " + job.mnid +
      "\n  - Solution: " + soln
    );

    var submitTime = (Date.now() / 1000) | 0;

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

    if (nTimeInt < (job.rpcData.curtime - 30) || nTimeInt > submitTime + 7200) {
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

    // Fetch worker data from Redis using pslAddress as the key
    //const refreshedWorkerDataString = await g_redisClient.get(`worker:data:${pslAddress}`);
    //const refreshedWorkerData = JSON.parse(refreshedWorkerDataString) || {};

    // DEBUG - remove these test data
    // job.prevHashReversed = "20e87b9ad6547ee05575a1b511f5f81bd618c810e1d6013bd6e18a2150928302"
    // job.merkleRootReversed = "08ec3d49c7882563766d4bd39d4f623ac80c8a00dbaf1ba20732f57fbd98dcd2"
    // job.hashReserved = "d60cbc2d19f4e180dfd8d2170cca76badfcfcdde2f6b6cd55faf2f33d60c2b52"
    // nTime = "0b18cd65"
    // job.rpcData.bits = "200766ef"
    // refreshedWorkerData.currently_selected_supernode_pastelid_pubkey = "jXXwP91HjyZ2q5zFfHAQCeoDK5TvnwEYuJcJYxXsq9xeYgmULk3SR8Er2iymoTaQ4N9M2rcowFBJGXoZ6ye1gN"
    // refreshedWorkerData.currently_selected_supernode_signature = "CyN3QjpDzjdSXEjz+f6kUdAUY8hCa0xWLt8ryfRI9TZkWoNu+trioE17HxIKZMv+3jrAT8xRz6WAMU++JQV7TnXAWYPC3wqysez9pSi+b5k+LDts3u+BbiBGd+z4VzgGy/9cl4E+vWgfjT1bA9otIDoA"
    // nonce = "0600f2e5a3dc7d15ebd662139ebbae38ab99cfd65eeef76428f237f08e000000"
    // soln = "fd40050100f29d530ebedfb601d10f023e1ee963b170de842ed5a7440510833b1645147b5fbd5481e149d19f4d137f1d6d87a81da1bc9cb5ddd04edcfe237b13b28a183dc60f4d46ca2d554c1a87dbe8d9ef08299fdf4604c6c29be84332e996f675b722cc322d99761203400c5beae193580efafcc611683058c2cdf61edfa00b0dc65b87162fbc738272953137cb5ebd9d70911d9c1b86326eb149922bf31a3afeae77dbf7053cf897d0030ae3357b5195e92baad2416dc78156ba4156f2f40552b3a47f0c29c0fe4e24582a594b11421b514b4407f101fa6bc3e2fb7ea60170b7b70898d7d6cabbc51075c58399f601a9bf76027f9d73da96945317f66004faab7bcb0a926b414df5e915ffa06e6ae6d734bf08b6a0a43ad0d0e54185138a3049148a340f7d08570b8a5eaf9dde1a352c0830c495cd4c11f5e51bef1435d9eb1a125c8d9551f653d95ce1cd24fe03b3f8260307a035cf510af183e85112aab7b194760f0b61fb0ca3eb786d475df5c319f3e10162ab1abf389de3de084ea612a8e6a823fa6f339befd338db1299ddcd3835eca42b9c19624fd636e551aeca25d627e274cf711bec9c4cd0d643d39147d352147d40e252a4b2f3fc36669d486a22feb3de9a93a9052587d9f961de7da51e15cf8361d526d9a47a429449a60b6e20413d079336a1cd95399a9fabd49d2763c6e89f5657d537eae4048db215afcbc47db82d57bab8fa7646a88ff8aa7618bfb239d3cbcba17ef044b7967930337fdf7e3bee1bd11697149a64a96c0aa201a2aadd5faa21ff36732bb44a92d2568b4b8fddd5471d3d30adde6c162a1409176b7381936fbcf0b0d326e3fd9f82e3f29a45d409d7a55ec3635e63af9847b7a57b95b21ea6d397e10f9ec730d052774d9053d6db487408ee8b539663aa2d698b7e8ce6d1ab564f93e17ea522f584e13e57d401ff8793a824294b6fb991f0ba43a0dccdabd716130708639b4d89c91bb07b81dbc6e4e4fd61df6f7336043d24a37e19108bff48314cc0bbc2077150be6289442e74e16562f167af6314be01aeb6de4776544c8d0213e7c9754ef46d2c4ee637a9b563a1ac457be68c06752242f2e25627630fb396255a80d92e0f2bd747079a8eacb3d0087fc25bb17e0346e118c83b08ccbc18c7832f885bdb2568d3abe19a7809fb848f7fb96305cb1d26d827e0d3efe0e22067164a9927a9375fb3126ef525a1f8d69bf2eb73ba1ca87a7a6fa79676d30c54b19433578f28da60b1dada734e2b3dcb5a58d822cfb1ab6dd28fadc26c82f442da23e9aa5390222f0c3167237b991187518ac32839a7cb0f1647fd7e74342ac73224e949b3cddd0624fdd522338fdf3e051b24d157e7f8dc315bcefe559abdc3aabdeaa8b9cd9c309675c34ca07d153b6af46605ad3b5d5b5db2fbdc05a5468b80963e2ebb0e634201b240b9d567d33aed09cf10d137ce599b7010923412ae9839308db769ab14c0f573b8db11ddfe485425e1f861615dced9eac7503966e1e2a044a770e5974885bdc802efcd7ed31b10811502cbca338d4a3a435e049e03ca45c6b8c5df1fd6f5a36bb3d0fde5b712ded7c78ed5da09d85e3515f447ccce0903f448efb2a6034900d4ff409355da3ff177ac0bde3b0b28e6f5cd4eb1bc070b673df2d909ed074e84c9904d2eef42413ca88045fa4ad81ddb0a847a9905c7bbcc4dd2b2d23332b525ea337559c91e1deb485c70c327ea54435f92c8cbb4f93c32e9b233d7faf5dda56be98b01a83b2a774a96a0465c3c7431acfa72caccaf85fb9aa58e34ce1b670356fb3f6d51ab6477acd9a6c375f8b6f105fe0d46760a1cf17436217ea11c9c7cb31607262a0accb77990bd77eb3346e4ef7898dd75ff2f3b18343669730699b33f5aa6"

    // Serialize the header data without solution
    const equihashInputBuffer = job.serializeEquihashInput(nTime, nonce);
    // Serialize full header
    const headerBuffer = job.serializeBlockHeader(equihashInputBuffer, soln);

    var headerHash;

    switch (options.coin.algorithm) {
      default:
        headerHash = util.sha256d(headerBuffer);
        break;
    }

    var headerBigNum = bignum.fromBuffer(headerHash, {
      endian: "little",
      size: 32,
    });

    //    console.log(`        Equihash input: ${equihashInputBuffer.toString("hex")}`);
    //    console.log(`         Header buffer: ${headerBuffer.toString("hex")}`);
    console.log(` Header hash: ${headerBigNum.toString(16).padStart(64, '0')}`);
    console.log(`  job.target: ${job.target.toString(16).padStart(64, '0')}`);

    var blockHashInvalid;
    var blockHash;
    var blockHex;

    var shareDiff = (diff1 / headerBigNum.toNumber()) * shareMultiplier;
    var blockDiffAdjusted = job.difficulty * shareMultiplier;

    // check if valid solution
    if (
      hashDigest(
        equihashInputBuffer,
        Buffer.from(soln.slice(solutionSlice), "hex")
      ) !== true
    ) {
      //console.log('invalid solution');
      return shareError([20, "invalid solution"]);
    }

    var shouldEmitShare = true;

    //check if block candidate
    if (headerBigNum.le(job.target)) {
      // console.log('begin serialization');
      blockHex = job.serializeBlock(headerBuffer).toString("hex");
      blockHash = util.reverseBuffer(headerHash).toString("hex");
      // console.log('end serialization');
    } else {
      // console.log('low difficulty share');
      if (options.emitInvalidBlockHashes)
        blockHashInvalid = util
          .reverseBuffer(util.sha256d(headerBuffer))
          .toString("hex");

      //Check if share didn't reached the miner's difficulty)
      if (shareDiff / difficulty < 0.00001) {
        var shouldEmitShare = false;
        console.log('Share did not reach the miner\'s difficulty');
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

    if (shouldEmitShare) {
      const shareId = generateShareId(shareData); // Generate a unique ID for the share

      // The share event will now be emitted in the validateShareAsync function if the share is valid
      // console.log(`Validating share now with data: ${JSON.stringify(shareData)}`);

      await validateShareAsync(shareData, shareId, _this, blockHex); // Pass the context (_this) if necessary
    }

    // Return the result indicating that processing is in progress
    return { result: "processing", error: null };
  };
});
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
