var bignum = require("bignum");

var merkle = require("./merkleTree.js");
var transactions = require("./transactions.js");
var util = require("./util.js");

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
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    // Optionally, implement retry logic or error handling here
  }
}

// Call connectRedis to establish the connection
connectRedis();

// Function to serialize the length in compact size format
function writeCompactSize(length, buffer, pos) {
  let bytesWritten;
  if (length < 253) {
      buffer.writeUInt8(length, pos);
      bytesWritten = 1;
  } else if (length <= 0xffff) {
      buffer.writeUInt8(253, pos);
      buffer.writeUInt16LE(length, pos + 1);
      bytesWritten = 3;
  } else if (length <= 0xffffffff) {
      buffer.writeUInt8(254, pos);
      buffer.writeUInt32LE(length, pos + 1);
      bytesWritten = 5;
  } else {
      buffer.writeUInt8(255, pos);
      buffer.writeBigUInt64LE(BigInt(length), pos + 1);
      bytesWritten = 9;
  }
  return bytesWritten;
}

// function to get compact size length
function getCompactSizeLength(length) {
  if (length < 253) {
      return 1;
  } else if (length <= 0xffff) {
      return 3;
  } else if (length <= 0xffffffff) {
      return 5;
  } else {
      return 9;
  }
}

async function validateShareAsync(shareData, shareId, context) {
  try {
    const remoteIp = shareData.remoteAPIValidatorIp;
    const pslAddressOfWorker = shareData.pslAddress;

    // Fetch worker data from Redis
    const workerDataString = await redisClient.get(
      `worker:data:${pslAddressOfWorker}`
    );
    if (!workerDataString)
      throw new Error(`Worker ${pslAddressOfWorker} data not found in Redis.`);
    const workerData = JSON.parse(workerDataString || "{}");

    let canAcceptShares = workerData.can_accept_mining_workers_shares_currently;
    console.log(
      `Validating share with ID ${shareId} from remote IP ${remoteIp} for worker ${pslAddressOfWorker}; Pool Can Accept Worker's Shares Currently: ${canAcceptShares}`
    );

    if (workerData && canAcceptShares) {
      // Update share status to valid
      shareData.status = "valid";
      await redisClient.set(`share:${shareId}`, JSON.stringify(shareData));

      // Emit the share event
      context.emit("share", shareData);
    } else {
      // If canAcceptShares is false, mark the share as invalid
      shareData.status = "invalid";
      console.error(
        `Worker ${pslAddressOfWorker} is not allowed to submit shares currently. Marking share with ID ${shareId} as invalid.`
      );
    }

    // Regardless of share validity, update its status in Redis
    await redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
  } catch (error) {
    console.error("Error in share validation:", error);
    // Check if shareData is defined before attempting to mark it as invalid
    if (shareData) {
      shareData.status = "invalid";
      await redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
    }
  }
}
/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
 **/
var BlockTemplate = (module.exports = function BlockTemplate(
  jobId,
  rpcData,
  recipients,
  poolAddress,
  poolHex,
  coin,
  daemon
) {
  //private members
  var submits = [];

  //public members
  this.rpcData = rpcData;
  this.jobId = jobId;
  this.algoNK =
    coin.parameters && coin.parameters.N && coin.parameters.K
      ? coin.parameters.N + "_" + coin.parameters.K
      : undefined;
  this.persString = coin.parameters
    ? coin.parameters.personalization
    : undefined;

  // get target info
  this.target = bignum(rpcData.target, 16);

  this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

  // generate the fees and coinbase tx
  let blockReward = {
    total: this.rpcData.miner * (coin.subsidyMultipleOfSatoshi || 100000000),
  };

  var masternodeReward;
  var masternodePayee;
  var masternodePayment;
  var zelnodeBasicAddress;
  var zelnodeBasicAmount;
  var zelnodeSuperAddress;
  var zelnodeSuperAmount;
  var zelnodeBamfAddress;
  var zelnodeBamfAmount;

  if (coin.vFundingStreams) {
    // Zcash has moved to fundingstreams via getblocksubsidy.
    // This will calculate block reward and fundingstream totals.

    fundingstreamTotal = 0;
    for (var i = 0, len = this.rpcData.fundingstreams.length; i < len; i++) {
      fundingstreamTotal += this.rpcData.fundingstreams[i]["valueZat"];
    }

    blockReward = {
      miner: this.rpcData.miner * 100000000,
      fundingstream: fundingstreamTotal,
      total: this.rpcData.miner * 100000000 + fundingstreamTotal,
    };
  } else if (coin.payFoundersReward === true) {
    if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
      console.log("Error, founders reward missing for block template!");
    } else if (coin.payAllFounders) {
      // SafeCash / Genx
      if (!rpcData.masternode_payments_started) {
        // Pre masternodes
        blockReward = {
          miner: this.rpcData.miner,
          infrastructure: this.rpcData.infrastructure,
          giveaways: this.rpcData.giveaways,
          founderSplit: this.rpcData.loki,
          total:
            this.rpcData.miner +
            this.rpcData.founderstotal +
            this.rpcData.infrastructure +
            this.rpcData.giveaways,
        };
        //console.log(`SafeCash: ${this.rpcData.miner}`);
      } else {
        // console.log(this.rpcData);
        // Masternodes active
        blockReward = {
          miner: this.rpcData.miner,
          infrastructure: this.rpcData.infrastructure,
          giveaways: this.rpcData.giveaways,
          founderamount: this.rpcData.founderamount,
          total: this.rpcData.coinbasevalue,
        };
      }
    } else if (this.rpcData.gemlink) {
      blockReward = {
        total:
          (this.rpcData.miner +
            this.rpcData.founders +
            (this.rpcData.treasury || 0) +
            this.rpcData.securenodes +
            this.rpcData.supernodes) *
            100000000 +
          (this.rpcData.premineReward || 0),
      };
    } else {
      blockReward = {
        total:
          (this.rpcData.miner +
            this.rpcData.founders +
            (this.rpcData.treasury || 0) +
            this.rpcData.securenodes +
            this.rpcData.supernodes) *
          100000000,
      };
    }
  }

  //Vidulum VRS Support
  if (coin.VRSEnabled === true) {
    //VRS Activation is Live
    if (this.rpcData.height >= coin.VRSBlock) {
      if (!this.rpcData.vrsReward || this.rpcData.vrsReward.length <= 0) {
        console.log(
          "Error, vidulum reward system payout missing for block template!"
        );
      } else {
        blockReward = {
          total:
            this.rpcData.miner * 100000000 +
            this.rpcData.vrsReward +
            this.rpcData.payee_amount,
        };
      }
    } else {
      //VRS Ready but not yet activated by chain
      blockReward = {
        total: this.rpcData.miner * 100000000 + this.rpcData.payee_amount,
      };
    }
  }

  masternodeReward = rpcData.payee_amount;
  masternodePayee = rpcData.payee;
  masternodePayment = rpcData.masternode_payments;
  zelnodeBasicAddress = coin.payZelNodes ? rpcData.basic_zelnode_address : null;
  zelnodeBasicAmount = coin.payZelNodes ? rpcData.basic_zelnode_payout || 0 : 0;
  zelnodeSuperAddress = coin.payZelNodes ? rpcData.super_zelnode_address : null;
  zelnodeSuperAmount = coin.payZelNodes ? rpcData.super_zelnode_payout || 0 : 0;
  zelnodeBamfAddress = coin.payZelNodes ? rpcData.bamf_zelnode_address : null;
  zelnodeBamfAmount = coin.payZelNodes ? rpcData.bamf_zelnode_payout || 0 : 0;

  var fees = [];
  rpcData.transactions.forEach(function (value) {
    fees.push(value);
  });
  this.rewardFees = transactions.getFees(fees);
  rpcData.rewardFees = this.rewardFees;

  if (typeof this.genTx === "undefined") {
    this.genTx = transactions
      .createGeneration(
        rpcData,
        blockReward,
        this.rewardFees,
        recipients,
        poolAddress,
        poolHex,
        coin,
        masternodeReward,
        masternodePayee,
        masternodePayment,
        zelnodeBasicAddress,
        zelnodeBasicAmount,
        zelnodeSuperAddress,
        zelnodeSuperAmount,
        zelnodeBamfAddress,
        zelnodeBamfAmount
      )
      .toString("hex");
    this.genTxHash = transactions.txHash();

    /*
        console.log('this.genTxHash: ' + transactions.txHash());
        console.log('this.merkleRoot: ' + merkle.getRoot(rpcData, this.genTxHash));
        */
  }

  // generate the merkle root
  this.prevHashReversed = util
    .reverseBuffer(Buffer.from(rpcData.previousblockhash, "hex"))
    .toString("hex");
  if (rpcData.finalsaplingroothash) {
    this.hashReserved = util
      .reverseBuffer(Buffer.from(rpcData.finalsaplingroothash, "hex"))
      .toString("hex");
  } else {
    this.hashReserved =
      "0000000000000000000000000000000000000000000000000000000000000000";
  }

  this.merkleRoot = merkle.getRoot(rpcData, this.genTxHash);
  this.merkleRootReversed = util
    .reverseBuffer(Buffer.from(this.merkleRoot, "hex"))
    .toString("hex");

  this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase
  // we can't do anything else until we have a submission

  this.txs = new Array();
  this.txs.push(this.genTx);
  for (var tx of rpcData.transactions) {
    this.txs.push(tx.data);
  }

  this.calculateTrees = async function () {
    return new Promise((resolve) => {
      daemon.cmd(
        "getblockmerkleroots",
        [
          this.txs,
          this.rpcData.certificates.length > 0
            ? this.rpcData.certificates.map((el) => el.data)
            : [],
        ],
        (result) =>
          result.error
            ? resolve(result.error)
            : resolve(this.getTrees(result[0].response))
      );
    });
  };

  this.getTrees = function (response) {
    this.merkleRoot = response.merkleTree;
    this.hashReserved = util
      .reverseBuffer(new Buffer.alloc(response.scTxsCommitment, "hex"))
      .toString("hex");
    this.merkleRootReversed = util
      .reverseBuffer(new Buffer.alloc(this.merkleRoot, "hex"))
      .toString("hex");
    this.certCount = this.rpcData.certificates.length;
  };

this.stringToHex = function stringToHex(str) {
  return str.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/**
 *  Serialize the header data for the block.
 * 
 * @param {number} nTime - The current time
 * @param {object} workerData - The worker data
 * @returns {object} - The serialized header data 
 *    v4data: The v4 data
 *    v5data: The v5 data (for block version 5 only, null otherwise)
 */
this.serializeHeaderData = async function(nTime, workerData) {
    // calculate size of the v4 data without nonce and solution
    // - version (4 bytes)
    // - prevHash (32 bytes)
    // - merkleRoot (32 bytes)
    // - finalSaplingRoot (32 bytes)
    // - time (4 bytes)
    // - bits (4 bytes)
    const v4DataWithoutNonceAndSolutionSize = 4 + 32 + 32 + 32 + 4 + 4;
  
    var v4data = Buffer.alloc(v4DataWithoutNonceAndSolutionSize);
    var pos = 0;

    // Version (4 bytes)
    v4data.writeInt32LE(this.rpcData.version, pos);
    pos += 4;

    // Previous block hash (32 bytes), starts with compact size
    var bufLen = this.prevHashReversed.length / 2;
    Buffer.from(this.prevHashReversed, 'hex').copy(v4data, pos);
    pos += bufLen;

    // Merkle root (32 bytes), starts with compact size
    bufLen = this.merkleRootReversed.length / 2;
    Buffer.from(this.merkleRootReversed, 'hex').copy(v4data, pos);
    pos += bufLen;

    // Final sapling root (32 bytes), starts with compact size
    bufLen = this.hashReserved.length / 2;
    Buffer.from(this.hashReserved, 'hex').copy(v4data, pos);
    pos += bufLen;

    // Time (4 bytes)
    Buffer.from(nTime, 'hex').copy(v4data, pos);
    pos += 4;

    // Bits, difficulty (4 bytes)
    Buffer.from(this.rpcData.bits, 'hex').copy(v4data, pos);

    // Conditional handling for Version 5 specific fields
    // - PastelID (variable length)
    // - previous block merkle root signature (variable length)
    var v5data;
    if (this.rpcData.version >= 5) {
      pos = 0;
      const signatureBuffer = Buffer.from(workerData.currently_selected_supernode_signature, "base64");
      const signatureLengthInBytes = signatureBuffer.length;
      const pastelIdLengthInBytes = workerData.currently_selected_supernode_pastelid_pubkey.length;

      const v5BufferSize = 
        getCompactSizeLength(pastelIdLengthInBytes) + pastelIdLengthInBytes + 
        getCompactSizeLength(signatureLengthInBytes) +  signatureLengthInBytes;

      v5data = Buffer.alloc(v5BufferSize);
      // PastelID (variable length)
      const pastelIdBuffer = Buffer.from(workerData.currently_selected_supernode_pastelid_pubkey, "utf-8");
      // PastelID compact size
      pos += writeCompactSize(pastelIdLengthInBytes, v5data, pos);
      pastelIdBuffer.copy(v5data, pos);
      pos += pastelIdBuffer.length;
      // previous block merkle root signature (variable length)
      //base64 encoded signature, first need to decode to bytes:
      pos += writeCompactSize(signatureLengthInBytes, v5data, pos);
      signatureBuffer.copy(v5data, pos);
    }
  
    return { v4data, v5data: v5data || null };
  };

  /**
   * Serialize the Equihash input for the block to check the solution.
   * 
   * @param {object} headerDataParts - The header data (v4 and v5)
   * @param {string} nonce - The nonce (hex string)
   * @returns {Buffer} - The serialized Equihash input
   */
  this.serializeEquihashInput = function (headerDataParts, nonce) {
    // Equihash input consists of:
    // - v4 header data without nonce and solution
    // - v5 header data (if present)
    // - nonce (32 bytes)
    const bufSize = headerDataParts.v4data.length + 
      (headerDataParts.v5data ? headerDataParts.v5data.length : 0) + 
      nonce.length / 2;
    const equihashInput = Buffer.alloc(bufSize);
    let pos = 0;
    // v4 header data
    headerDataParts.v4data.copy(equihashInput, pos);
    pos += headerDataParts.v4data.length;

    // v5 header data (if present)
    if (headerDataParts.v5data) {
      headerDataParts.v5data.copy(equihashInput, pos);
      pos += headerDataParts.v5data.length;
    }

    // nonce (32 bytes)
    Buffer.from(nonce, 'hex').copy(equihashInput, pos);
    return equihashInput;
  };

  /**
   * Serialize the block header.
   * 
   * @param {object} headerDataParts - The header data (v4 and v5)
   * @param {string} nonce - The nonce (hex string)
   * @param {string} solution - The solution (hex string)
   * @returns {Buffer} - The serialized block header
   */
  this.serializeBlockHeader = function (headerDataParts, nonce, solution) {
    // block header structure:
    // - v4 header without nonce and solution
    // - nonce (32 bytes)
    // - solution (variable length)
    // - v5 header (if present)

    var headerBufSize = headerDataParts.v4data.length + 
      nonce.length / 2 +
      getCompactSizeLength(solution.length / 2) + solution.length / 2 +
      (headerDataParts.v5data ? headerDataParts.v5data.length : 0);

    buf = Buffer.alloc(headerBufSize);
    let pos = 0;
    // v4 header data
    headerDataParts.v4data.copy(buf, pos);
    pos += headerDataParts.v4data.length;
    
    // nonce (32 bytes)
    Buffer.from(nonce, 'hex').copy(buf, pos);
    pos += nonce.length / 2;

    // solution (variable length)
    pos += writeCompactSize(solution.length / 2, buf, pos);
    Buffer.from(solution, 'hex').copy(buf, pos);
    pos += solution.length / 2;

    // v5 header data (if present)
    if (headerDataParts.v5data) {
      headerDataParts.v5data.copy(buf, pos);
      pos += headerDataParts.v5data.length;
    }

    return buf;
  }

  /**
   * Serialize the block data (concatenates block header and transaction data).
   * 
   * @param {Buffer} headerBuffer - The block header buffer
   * @returns {Buffer} - The serialized block data
   */
  this.serializeBlock = function (headerBuffer) {
    // block structure:
    // - block header
    // - transaction data (variable length)
    // - certificate data (if present, variable length)

    var transactionBufSize = 0;
    this.rpcData.transactions.forEach(function (value) {
      transactionBufSize += value.data.length / 2;
    });

    var blockBufSize = headerBuffer.length + 
      getCompactSizeLength(this.txCount) + this.genTx.length / 2 + transactionBufSize;
    const IsCertData = this.rpcData.version == 3 && (coin.symbol == "zen" || coin.symbol == "zent");
    if (IsCertData) {
      blockBufSize += getCompactSizeLength(this.certCount);
      this.rpcData.certificates.forEach(function (value) {
        blockBufSize += value.data.length / 2;
      });
    }
    buf = Buffer.alloc(blockBufSize);

    let pos = 0;
    // block header
    headerBuffer.copy(buf, pos);
    pos += headerBuffer.length;

    // transaction data (variable length)
    pos += writeCompactSize(this.txCount, buf, pos);
    Buffer.from(this.genTx, 'hex').copy(buf, pos);
    pos += this.genTx.length / 2;
    this.rpcData.transactions.forEach(function (value) {
      Buffer.from(value.data, 'hex').copy(buf, pos);
      pos += value.data.length / 2;
    });

    // certificate data (variable length)
    if (IsCertData) {
      pos += writeCompactSize(this.certCount, buf, pos);
      this.rpcData.certificates.forEach(function (value) {
        Buffer.from(value.data, 'hex').copy(buf, pos);
        pos += value.data.length / 2;
      });
    }

    return buf;
  };

  // submit the block header
  this.registerSubmit = function (header, soln) {
    var submission = (header + soln).toLowerCase();
    if (submits.indexOf(submission) === -1) {
      submits.push(submission);
      return true;
    }
    return false;
  };

  // used for mining.notify
  this.getJobParams = function () {
    if (!this.jobParams) {
      this.jobParams = [
        this.jobId,
        util.packUInt32LE(this.rpcData.version).toString("hex"), // Assuming packUInt32LE() returns a buffer or string that doesn't need further conversion
        this.prevHashReversed,
        this.merkleRootReversed,
        this.hashReserved,
        util.packUInt32LE(rpcData.curtime).toString("hex"), // Same assumption as above
        util
          .reverseBuffer(Buffer.from(this.rpcData.bits, "hex"))
          .toString("hex"),
        true,
        this.algoNK,
        this.persString,
      ];
    }
    return this.jobParams;
  };
});

// Export BlockTemplate and validateShareAsync
module.exports = {
  BlockTemplate, // Export the constructor function for use with 'new'
  validateShareAsync, // Export the async function
};