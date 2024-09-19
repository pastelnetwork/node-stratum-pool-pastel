// blockTemplate.js

const bignum = require("bignum");

const merkle = require("./merkleTree.js");
const transactions = require("./transactions.js");
const util = require("./util.js");
const Redis = require("./redisClient.js");

let g_redisClient = null;

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

async function getValidPastelIdAndSignature() {
  try {
    if (!g_redisClient) {
      g_redisClient = await Redis.checkRedisConnection(g_redisClient);
    }

    // Get all worker keys from Redis synchronously
    const keys = await g_redisClient.keys('worker:data:*');

    if (!keys || keys.length === 0) {
      console.log("No worker data found in Redis.");
      return null;
    }

    // Randomly select a worker key
    const randomKey = keys[Math.floor(Math.random() * keys.length)];

    // Retrieve the worker data from Redis synchronously
    const workerDataString = await g_redisClient.get(randomKey);

    if (!workerDataString) {
      console.log(`No data found for key ${randomKey}.`);
      return null;
    }

    const workerData = JSON.parse(workerDataString);

    if (!workerData.can_accept_mining_workers_shares_currently) {
      console.log(`Worker ${workerData.remote_ip} is not currently eligible to sign a block.`);
      return null;
    }

    const pastelId = workerData.currently_selected_supernode_pastelid_pubkey;
    const signature = workerData.currently_selected_supernode_signature;

    console.log(`Found valid PastelID and signature for worker ${workerData.remote_ip}:`);
    console.log(`  -  PastelID: ${pastelId}`);
    console.log(`  -  Signature: ${signature}`);

    return { pastelId, signature };
  } catch (error) {
    console.error("Error retrieving valid PastelID and signature:", error);
    return null;
  }
}

async function validateShareAsync(shareData, shareId, context, blockHex) {

  try {
    if (!g_redisClient) {
      g_redisClient = await Redis.checkRedisConnection(g_redisClient);
    }

    const remoteIp = shareData.remoteAPIValidatorIp;
    const pslAddressOfWorker = shareData.pslAddress;

    // Fetch worker data from Redis
    const workerDataString = await g_redisClient.get(
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
      await g_redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
      // Emit the share event
      context.emit("share", shareData, blockHex);
    } else {
      // If canAcceptShares is false, mark the share as invalid
      shareData.status = "invalid";
      console.error(
        `Worker ${pslAddressOfWorker} is not allowed to submit shares currently. Marking share with ID ${shareId} as invalid.`
      );
    }

    // Regardless of share validity, update its status in Redis
    await g_redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
  } catch (error) {
    console.error("Error in share validation:", error);
    // Check if shareData is defined before attempting to mark it as invalid
    if (shareData) {
      shareData.status = "invalid";
      await g_redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
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
    total: (this.rpcData.miner + this.rpcData.masternode) * (coin.subsidyMultipleOfSatoshi || 100000000),
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

  // masternodeReward = rpcData.payee_amount;
  // masternodePayee = rpcData.payee;
  // masternodePayment = rpcData.masternode_payments;
  masternodeReward = rpcData.masternodeinfo.amount;
  masternodePayee = rpcData.masternodeinfo.payee;
  masternodePayment = rpcData.masternodeinfo.script;
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
   *  Serialize equihash input (all block header fields without nonce and solution).
   * 
   * @param {number} nTime - The current time
   * @param {string} nonce - The nonce (hex string)
   * @returns {object} - The serialized header data 
   */
  this.serializeEquihashInput = function (nTime, nonce) {
    // calculate size of the v4 data without nonce and solution
    // - version (4 bytes)
    // - prevHash (32 bytes)
    // - merkleRoot (32 bytes)
    // - finalSaplingRoot (32 bytes)
    // - time (4 bytes)
    // - bits (4 bytes)
    // v5 data:
    // - mnid (variable length)
    // - previous block merkle root signature (variable length) - base64 encoded
    // - nonce (32 bytes)

    const signatureBuffer = Buffer.from(this.prevMerkleRootSignature, "base64");
    const signatureLengthInBytes = signatureBuffer.length;
    const pastelIdLengthInBytes = this.mnid.length;

    // calculate required serialized header size without nonce and solution
    var nDataSize = 4 + 32 + 32 + 32 + 4 + 4 +
      getCompactSizeLength(signatureLengthInBytes) + signatureLengthInBytes +
      getCompactSizeLength(pastelIdLengthInBytes) + pastelIdLengthInBytes +
      32;

    var header = Buffer.alloc(nDataSize);
    var pos = 0;

    // Version (4 bytes)
    header.writeInt32LE(this.rpcData.version, pos);
    pos += 4;

    // Previous block hash (32 bytes)
    var bufLen = this.prevHashReversed.length / 2;
    Buffer.from(this.prevHashReversed, 'hex').copy(header, pos);
    pos += bufLen;

    // Merkle root (32 bytes)
    bufLen = this.merkleRootReversed.length / 2;
    Buffer.from(this.merkleRootReversed, 'hex').copy(header, pos);
    pos += bufLen;

    // Final sapling root (32 bytes)
    bufLen = this.hashReserved.length / 2;
    Buffer.from(this.hashReserved, 'hex').copy(header, pos);
    pos += bufLen;

    // Time (4 bytes)
    Buffer.from(nTime, 'hex').copy(header, pos);
    pos += 4;

    // Bits, difficulty (4 bytes)
    bitsAsInt = parseInt(this.rpcData.bits, 16);
    header.writeUInt32LE(bitsAsInt, pos);
    pos += 4;

    // v5 fields (mnid and signature)
    // mnid (variable length)
    const pastelIdBuffer = Buffer.from(this.mnid, "utf-8");
    // mnid (Pastel ID) compact size
    pos += writeCompactSize(pastelIdLengthInBytes, header, pos);
    pastelIdBuffer.copy(header, pos);
    pos += pastelIdBuffer.length;
    // previous block merkle root signature (variable length)
    //base64 encoded signature, first need to decode to bytes:
    pos += writeCompactSize(signatureLengthInBytes, header, pos);
    signatureBuffer.copy(header, pos);
    pos += signatureBuffer.length;

    // Nonce (32 bytes)
    Buffer.from(nonce, 'hex').copy(header, pos);
    return header;
  };

  /**
   * Serialize the block header.
   * 
   * @param {object} equihashInput - The header data without nonce and solution
   * @param {string} solution - The solution (hex string)
   * @returns {Buffer} - The serialized block header
   */
  this.serializeBlockHeader = function (equihashInput, solution) {
    // block header structure:
    // - header data without solution
    // - solution (variable length)

    const headerBufSize = equihashInput.length + solution.length / 2;

    buf = Buffer.alloc(headerBufSize);
    let pos = 0;
    // header data without nonce and solution
    equihashInput.copy(buf, pos);
    pos += equihashInput.length;

    // solution (variable length)
    Buffer.from(solution, 'hex').copy(buf, pos);

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

    var txCount = this.txCount.toString(16);
    if (Math.abs(txCount.length % 2) == 1) {
      txCount = "0" + txCount;
    }

    if (this.txCount <= 0x7f) {
      var varInt = new Buffer.from(txCount, 'hex');
    } else if (this.txCount <= 0x7fff) {
      if (txCount.length == 2) {
        txCount = "00" + txCount;
      }
      var varInt = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer.from(txCount, 'hex'))]);
    }

    buf = new Buffer.concat([
      headerBuffer,
      varInt,
      new Buffer.from(this.genTx, 'hex')
    ]);

    if (this.rpcData.transactions.length > 0) {
      this.rpcData.transactions.forEach(function (value) {
        tmpBuf = new Buffer.concat([buf, new Buffer.from(value.data, 'hex')]);
        buf = tmpBuf;
      });
    }

    return buf;
  };

  // Keep track of unique nonce+soln pairs to prevent duplicate shares
  this.registerSubmit = function (nonce, soln) {
    var submission = (nonce + soln).toLowerCase();
    if (submits.indexOf(submission) === -1) {
      submits.push(submission);
      return true;
    }
    return false;
  };

  // used for mining.notify
  this.getJobParams = async function () {
    if (!this.jobParams) {
      // Call getValidPastelIdAndSignature to get mnid and prevMerkleRootSignature synchronously
      const result = await getValidPastelIdAndSignature();
      if (!result) {
        console.error("No valid PastelID and signature.");
        return null;
      }

      const { pastelId, signature } = result;
      this.mnid = pastelId;
      this.prevMerkleRootSignature = signature;
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
        this.algoNK,     // "200_9"
        this.persString, // personalization string
        this.mnid,       // v5: mnid
        Buffer.from(this.prevMerkleRootSignature, 'utf8').toString('hex'),  // v5: prevMerkleRootSignature
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
