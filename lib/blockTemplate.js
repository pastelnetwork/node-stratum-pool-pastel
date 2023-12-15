var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

const axios = require('axios'); // Ensure axios is installed via npm
const MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT = 9997; // Port number as a constant

async function getSupernodeInfo(remoteIp, token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/get_merkle_signature_from_remote_machine/${remoteIp}`;
        const response = await axios.get(url, { headers: { Authorization: token } });
        // The response.data is expected to be an object conforming to SignedPayloadResponse
        return response.data;
    } catch (error) {
        console.error('Error fetching supernode info:', error);
        return null;
    }
}

async function checkSupernodeEligibility(supernodePastelIdPubKey, token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/check_if_supernode_is_eligible_to_sign_block/${supernodePastelIdPubKey}`;
        const response = await axios.get(url, { headers: { Authorization: token } });
        return response.data; // Returns SupernodeEligibilityResponse
    } catch (error) {
        console.error('Error checking supernode eligibility:', error);
        return null;
    }
}

async function validateSupernodeSignature(supernodePastelIdPubKey, supernodeSignature, signedDataPayload, token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/validate_supernode_signature`;
        const response = await axios.get(url, {
            params: {
                supernode_pastelid_pubkey: supernodePastelIdPubKey,
                supernode_pastelid_signature: supernodeSignature,
                signed_data_payload: signedDataPayload
            },
            headers: { Authorization: token }
        });
        return response.data; // Returns ValidateSignatureResponse
    } catch (error) {
        console.error('Error validating supernode signature:', error);
        return null;
    }
}

async function validateShareAsync(shareId, context) {
    const shareDataString = await redisClient.get(`share:${shareId}`);
    const shareData = JSON.parse(shareDataString);

    // Assume you have these values available
    const remoteIp = shareData.ipAddress; // Example: shareData might contain the IP address
    const authToken = 'your_auth_token'; // Replace with the actual auth token

    try {
        // Fetch supernode information
        const supernodeInfo = await getSupernodeInfo(remoteIp, authToken);

        if (!supernodeInfo) {
            throw new Error("Failed to fetch supernode info");
        }

        // Check supernode eligibility
        const eligibilityResponse = await checkSupernodeEligibility(supernodeInfo.pastelid, authToken);

        if (!eligibilityResponse || !eligibilityResponse.is_eligible) {
            throw new Error("Supernode is not eligible");
        }

        // Validate supernode signature
        const validateResponse = await validateSupernodeSignature(
            supernodeInfo.pastelid, 
            supernodeInfo.signature, 
            shareData.previousBlockMerkleRoot, // You'll need to ensure this is part of shareData
            authToken
        );

        if (!validateResponse || !validateResponse.is_signature_valid) {
            throw new Error("Supernode signature is not valid");
        }

        // Update share status to valid
        shareData.status = 'valid';
        await redisClient.set(`share:${shareId}`, JSON.stringify(shareData));

        // Emit the share event (using the context to access the 'emit' method)
        context.emit('share', shareData);

    } catch (error) {
        console.error('Error in share validation:', error);
        // Update share status to invalid
        shareData.status = 'invalid';
        await redisClient.set(`share:${shareId}`, JSON.stringify(shareData));
    }
}


/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    extraNoncePlaceholder,
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
    this.algoNK = coin.parameters && coin.parameters.N && coin.parameters.K ? coin.parameters.N+'_'+coin.parameters.K : undefined;
    this.persString = coin.parameters ? coin.parameters.personalization : undefined;

    // get target info
    this.target = bignum(rpcData.target, 16);

    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

    // generate the fees and coinbase tx
    let blockReward = {
        'total': (this.rpcData.miner) * (coin.subsidyMultipleOfSatoshi || 100000000)
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
            "miner": (this.rpcData.miner * 100000000),
            "fundingstream": (fundingstreamTotal),
            "total": (this.rpcData.miner * 100000000 + fundingstreamTotal)
        }
    } else if (coin.payFoundersReward === true) {
        if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
            console.log('Error, founders reward missing for block template!');
        } else if (coin.payAllFounders) {
            // SafeCash / Genx
            if (!rpcData.masternode_payments_started) {
                // Pre masternodes
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderSplit": (this.rpcData.loki),
                    "total": (this.rpcData.miner + this.rpcData.founderstotal + this.rpcData.infrastructure + this.rpcData.giveaways)
                };
                //console.log(`SafeCash: ${this.rpcData.miner}`);
            } else {
                // console.log(this.rpcData);
                // Masternodes active
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderamount": (this.rpcData.founderamount),
                    "total": (this.rpcData.coinbasevalue)
                };
            }
        } else if (this.rpcData.gemlink) {
            blockReward = {
                "total": (this.rpcData.miner + this.rpcData.founders + (this.rpcData.treasury || 0) + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000 + (this.rpcData.premineReward || 0)
            };
        }
        else {
            blockReward = {
                "total": (this.rpcData.miner + this.rpcData.founders + (this.rpcData.treasury || 0) + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000
            };
        }
    }

    //Vidulum VRS Support
    if (coin.VRSEnabled === true) {
        //VRS Activation is Live
        if (this.rpcData.height >= coin.VRSBlock) {
            if (!this.rpcData.vrsReward || this.rpcData.vrsReward.length <= 0) {
                console.log('Error, vidulum reward system payout missing for block template!');
            } else {
                blockReward = {
                    "total": (this.rpcData.miner * 100000000) + this.rpcData.vrsReward + this.rpcData.payee_amount
                };
            }
        } else { //VRS Ready but not yet activated by chain
            blockReward = {
                "total": (this.rpcData.miner * 100000000) + this.rpcData.payee_amount
            };
        }
    }

    masternodeReward = rpcData.payee_amount;
    masternodePayee = rpcData.payee;
    masternodePayment = rpcData.masternode_payments;
    zelnodeBasicAddress = coin.payZelNodes ? rpcData.basic_zelnode_address : null;
    zelnodeBasicAmount = coin.payZelNodes ? (rpcData.basic_zelnode_payout || 0) : 0;
    zelnodeSuperAddress = coin.payZelNodes ? rpcData.super_zelnode_address : null;
    zelnodeSuperAmount = coin.payZelNodes ? (rpcData.super_zelnode_payout || 0) : 0;
    zelnodeBamfAddress = coin.payZelNodes ? rpcData.bamf_zelnode_address : null;
    zelnodeBamfAmount = coin.payZelNodes ? (rpcData.bamf_zelnode_payout || 0) : 0;

    var fees = [];
    rpcData.transactions.forEach(function (value) {
        fees.push(value);
    });
    this.rewardFees = transactions.getFees(fees);
    rpcData.rewardFees = this.rewardFees;

    if (typeof this.genTx === 'undefined') {
        this.genTx = transactions.createGeneration(
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
        ).toString('hex');
        this.genTxHash = transactions.txHash();

        /*
        console.log('this.genTxHash: ' + transactions.txHash());
        console.log('this.merkleRoot: ' + merkle.getRoot(rpcData, this.genTxHash));
        */
    }

    // generate the merkle root
    this.prevHashReversed = util.reverseBuffer(new Buffer.alloc(rpcData.previousblockhash, 'hex')).toString('hex');
    if (rpcData.finalsaplingroothash) {
        this.hashReserved = util.reverseBuffer(new Buffer.alloc(rpcData.finalsaplingroothash, 'hex')).toString('hex');
    } else {
        this.hashReserved = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
    }
    this.merkleRoot = merkle.getRoot(rpcData, this.genTxHash);
    this.merkleRootReversed = util.reverseBuffer(new Buffer.alloc(this.merkleRoot, 'hex')).toString('hex');

    this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase
    // we can't do anything else until we have a submission

    this.txs = new Array();
    this.txs.push(this.genTx)
    for (var tx of rpcData.transactions) {
        this.txs.push(tx.data);
    }

    this.calculateTrees = async function () {
        return new Promise(resolve => {
            daemon.cmd(
                'getblockmerkleroots',
                [this.txs,
                    this.rpcData.certificates.length > 0 ? this.rpcData.certificates.map(el => el.data) : []],
                result => result.error ? resolve(result.error) : resolve(this.getTrees(result[0].response))
            )
        })
    }
    this.getTrees = function (response) {
        this.merkleRoot = response.merkleTree;
        this.hashReserved = util.reverseBuffer(new Buffer.alloc(response.scTxsCommitment, 'hex')).toString('hex');
        this.merkleRootReversed = util.reverseBuffer(new Buffer.alloc(this.merkleRoot, 'hex')).toString('hex');
        this.certCount = this.rpcData.certificates.length;
    }

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
    this.serializeHeader = async function (nTime, nonce, remoteIp, authToken, previousBlockMerkleRoot) { // Modified serializeHeader function to be async and accept additional parameters
        var header = new Buffer.alloc(140);
        var position = 0;
        // First generate the header without supernode data:
        header.writeUInt32LE(this.rpcData.version, position, 4, 'hex');
        position += 4;
        header.write(this.prevHashReversed, position, 32, 'hex');
        position += 32;
        header.write(this.merkleRootReversed, position, 32, 'hex');
        position += 32;
        header.write(this.hashReserved, position, 32, 'hex');
        position += 32;
        header.write(nTime, position, 4, 'hex');
        position += 4;
        header.write(util.reverseBuffer(new Buffer.alloc(rpcData.bits, 'hex')).toString('hex'), position, 4, 'hex');
        position += 4;
        header.write(nonce, position, 32, 'hex');
        position += 32;
        // Fetch supernode information
        const supernodeInfo = await getSupernodeInfo(remoteIp, authToken);
        if (!supernodeInfo) {
            throw new Error("Failed to fetch supernode info");
        } // Now verify the supernode signature and that supernode's eligibility to mine the current block:
        // Check supernode eligibility
        const eligibilityResponse = await checkSupernodeEligibility(supernodeInfo.pastelid, authToken);
        if (!eligibilityResponse || !eligibilityResponse.is_eligible) {
            throw new Error("Supernode is not eligible to sign the block");
        }
        // Use the merkle root of the previous block as the signed data payload
        const signedDataPayload = previousBlockMerkleRoot;
        // Validate supernode signature
        const validateResponse = await validateSupernodeSignature(
            supernodeInfo.pastelid, 
            supernodeInfo.signature, 
            signedDataPayload, 
            authToken
        );
        if (!validateResponse || !validateResponse.is_signature_valid) {
            throw new Error("Supernode signature is not valid");
        }
        // Combine pastelid and signature with a '|' delimiter and convert to bytes
        const supernodeData = supernodeInfo.pastelid + "|" + supernodeInfo.signature;
        const supernodeBytes = Buffer.from(supernodeData, 'utf-8');
        // Ensure there's enough space in the header buffer to append supernodeBytes
        if (position + supernodeBytes.length > header.length) {
            throw new Error("Header buffer too small for supernode data");
        }
        // Append supernode data to the header
        supernodeBytes.copy(header, position);
        position += supernodeBytes.length;
        return header;
    };

    // join the header and txs together
    this.serializeBlock = function (header, soln) {
        var txCount = this.txCount.toString(16);
        if (Math.abs(txCount.length % 2) == 1) {
            txCount = "0" + txCount;
        }

        if (this.txCount <= 0xfc) {
            var varInt = new Buffer.alloc(txCount, 'hex');
        } else if (this.txCount <= 0x7fff) {
            if (txCount.length == 2) {
                txCount = "00" + txCount;
            }
            var varInt = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer.alloc(txCount, 'hex'))]);
        }

        buf = new Buffer.concat([
            header,
            soln,
            varInt,
            new Buffer.alloc(this.genTx, 'hex')
        ]);

        if (this.rpcData.transactions.length > 0) {
            this.rpcData.transactions.forEach(function (value) {
                tmpBuf = new Buffer.concat([buf, new Buffer.alloc(value.data, 'hex')]);
                buf = tmpBuf;
            });
        }


        if (this.rpcData.version == 3 && (coin.symbol == "zen" || coin.symbol == "zent")) {
            var certCount = this.certCount.toString(16);
            if (Math.abs(certCount.length % 2) == 1) {
                certCount = "0" + certCount;
            }
            if (this.certCount <= 0xfc) {
                var varIntCert = new Buffer.alloc(certCount, 'hex');
            } else if (this.certCount <= 0x7fff) {
                if (certCount.length == 2) {
                    certCount = "00" + certCount;
                }
                var varIntCert = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer.alloc(certCount, 'hex'))]);
            }
            tmpBuf = new Buffer.alloc(varIntCert, 'hex');
            certBuf = new Buffer.concat([buf, tmpBuf]);
            buf = certBuf;

            if (this.rpcData.certificates.length > 0) {
                this.rpcData.certificates.forEach(function (value) {
                    tmpBuf = new Buffer.concat([buf, new Buffer.alloc(value.data, 'hex')]);
                    buf = tmpBuf;
                });
            }
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
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.hashReserved,
                util.packUInt32LE(rpcData.curtime).toString('hex'),
                util.reverseBuffer(new Buffer.alloc(this.rpcData.bits, 'hex')).toString('hex'),
                true,
                this.algoNK,
                this.persString
            ];
        }
        return this.jobParams;
    };
};

module.exports = {
    validateShareAsync
};
