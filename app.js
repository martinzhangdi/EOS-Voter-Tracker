var express = require('express'),
  app = express(),
  cluster = require('cluster'),
  os = require("os"),
  fs = require("fs"),
  numCPUs = require('os').cpus().length;

app.disable('x-powered-by');

var compression = require('compression');
var EosApi = require('eosjs-api');
var Promise = require('promise');

eos = EosApi({
    httpEndpoint: "https://api.eosmedi.com",
    logger: {
    }
})



app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});

function getAccountData(account){
    return new Promise(function(resolve, reject){
        Promise.all([
            eos.getAccount({
                account_name: account
            }),
            eos.getCurrencyBalance({
                code: "eosio.token",
                account: account
            })
        ]).then(function(res){
            res[0].blance = res[1];
            resolve(res[0])
        }, function(err){
            reject(error);
            console.log("error", err);
        }).catch(function(err){
            reject(error);
            console.log("error", err);
        })
    })
}

var votedProducers = {};
var allVoters = {};
var votersInfo = {};
var voterLogs = [];
var proxyVoters = {};

var snapshotData = {};
var tableFile = "bpinfos.json";
var producerInfoTable = {};

function loadBpInfos(){
    try{
        producerInfoTable = JSON.parse(fs.readFileSync(tableFile, "utf-8"))
    }catch(e){
        producerInfoTable = {};
    }
}

loadBpInfos();

fs.watch(tableFile, function(){
    console.log("bpinfos change");
    loadBpInfos();
})



try{
    var _snapshotData = fs.readFileSync("snapshot.json", "utf-8");
    snapshotData = JSON.parse(_snapshotData);
}catch(e){
}


function loadFromFile(){
    try{
        var _data = fs.readFileSync("database.json", "utf-8");
        _data = JSON.parse(_data);
        if(_data.votedProducers){
            votedProducers = _data.votedProducers;
        }

        if(_data.allVoters){
            allVoters =  _data.allVoters;
        }
    }catch(e){}
}


function loadVoterInfoFromFile(){
    try{
        var _votersInfo = fs.readFileSync("votersInfo.json", "utf-8");
        _votersInfo = JSON.parse(_votersInfo);
        if(_votersInfo){
            votersInfo = _votersInfo;
        }
    }catch(e){}
}

fs.watch("./database.json", function(){
    console.log("database change");
    loadFromFile();
    loadVoterData();
})

loadVoterInfoFromFile();

var updateVotersList = [];

function loadVoterData(){
    (function Loop(){
        var voter = updateVotersList.shift();

        if(!voter){
            setTimeout(function(){
                Loop();
            }, 10 * 1000);
            return;
        }

        if(typeof voter !== "string"){
            voter = voter.account_name;
        }

        console.log('loadVoterData', updateVotersList.length);
        if(!votersInfo[voter]){
            console.log("updateVotersList load voter info", voter)
            getAccountData(voter).then(function(data){
                votersInfo[voter] = data;
                votersInfo[voter].update_time = Date.now();
                console.log("voter info updated", data);
                Loop();
            }, function(err){
                console.log(err);
            }).catch(function(err){
                console.log(err);
            })
        }else{
            setTimeout(function(){
                Loop();
            }, 50);
        }

    })();
}


var needUpdateVoterTable = {};

function freshVoterInfo(){
    var votersList = Object.keys(needUpdateVoterTable);
    (function Loop(){
        var voter = votersList.shift();
        if(!voter){
            setTimeout(function(){
                var votersList = Object.keys(needUpdateVoterTable);
                Loop();
            }, 10 * 1000);
            return;
        }
        getAccountData(voter).then(function(data){
            votersInfo[voter] = data;
            votersInfo[voter].update_time = Date.now();
            console.log("voter info updated", voter);
            delete needUpdateVoterTable[voter];
            Loop();
        }, function(err){
            console.log(err);
        }).catch(function(err){
            console.log(err);
        })
    })();
}


freshVoterInfo();


function voterInfoIsTimeout(voter){
    if(votersInfo[voter]){
        if(!votersInfo[voter].update_time){
            return true;
        }
        var timeLeft = Date.now() - votersInfo[voter].update_time;
        if(timeLeft > 60000){
            return true;
        }
    }
    return false;
}


function updateVoterInfo(voter){
    getAccountData(voter).then(function(data){
        votersInfo[voter] = data;
        votersInfo[voter].update_time = Date.now();
        console.log("voter info updated", voter);
    }, function(err){
        console.log(err);
    }).catch(function(err){
        console.log(err);
    })
}


loadVoterData();

setInterval(function(){
    console.log("output voterinfo database");
    console.log("votersInfo", Object.keys(votersInfo).length);
    console.log("allVoters",  Object.keys(allVoters).length);
    fs.writeFileSync("votersInfo.json", JSON.stringify(votersInfo));
}, 10 * 1000);


var allProducersMap = {};

function swapProducerVoters(producers){
    producers.rows.forEach(function(row){
        var producer = row.owner;
        if(votedProducers[row.owner]){
            row.voters = Object.keys(votedProducers[row.owner]['voters']).length;
            var bpinfo = producerInfoTable[producer];
            if(bpinfo && bpinfo.org){
                row.candidate_name = bpinfo.org.candidate_name;
                row.branding = bpinfo.org.branding;
                row.org_location = bpinfo.org.location;
            }
            delete row['producer_key'];
            allProducersMap[row.owner] = row;
        }
    })

    return producers.rows;
}

function pagination (pageNo, pageSize, array) {
    --pageNo;
    return array.slice(pageNo * pageSize, (pageNo + 1) * pageSize);
}


function loadProducers(){
    eos.getProducers({
        json: true,
        limit: 500
    }, (error, result) => {
        if(!error){
            swapProducerVoters(result);
        }
    })
}

loadProducers();

app.get('/getProducers', function(req, res, next){
    eos.getProducers({
        json: true,
        limit: 500
    }, (error, result) => {
        if(!error){
            var allProducers = swapProducerVoters(result);
            res.json(allProducers);
        }else{
            res.json({ error: error });
        }

    })
});


function getVoters(allVoters) {
    var voters = Object.keys(allVoters);
    var arr = [];

    voters.forEach(element => {
        arr.push(getVoterInfo(element, true));
    });

    arr.sort(function(i1,i2){
        var value2 = parseInt(i1.voter_info.staked);
        var value1 =  parseInt(i2.voter_info.staked);
        if (value1 < value2) {
            return -1;

        } else if (value1 > value2) {

            return 1;

        } else {

            return 0;
        }
    });
    return arr;
}

app.get('/getVoters', function(req, res, next){
    var page = req.query.p || 1;
    var size = req.query.size || 50;
    var data = getVoters(allVoters);
    var rows = pagination(page, size, data);
    res.json({
        rows: rows,
        total: Object.keys(allVoters).length
    });
});


function getVoterInfo(voter, missLoadCache){
    var cacheData = votersInfo[voter];

    if(!missLoadCache && voterInfoIsTimeout(voter)){
        updateVoterInfo(voter);
    }

    if(cacheData){
    }

    if(cacheData && snapshotData[cacheData.account_name]){
        votersInfo[voter].snapshot = snapshotData[cacheData.account_name];
        votersInfo[voter].eth = votersInfo[voter].snapshot.eth;
    }

    var voterIsProxy = proxyVoters[voter];
    if(voterIsProxy){
        var proxyStacked = 0;
        Object.keys(proxyVoters[voter]["voters"]).forEach(function(proxyVoter){
            var proxyVoterInfo = votersInfo[proxyVoter];
            proxyStacked += parseInt(proxyVoterInfo.voter_info.staked);
        })

        votersInfo[voter].voter_info.staked = proxyStacked;
    }

    if(!cacheData){
        console.log(cacheData, voter);
    }

    return votersInfo[voter];
}

app.get('/getVoter/:voter', function(req, res, next){
    var voter = req.params.voter;
    var voterData = getVoterInfo(voter, false);


    res.json(voterData);
});


app.get('/getProducer/:producer', function(req, res, next){
    console.log(req.params.producer);
    var producer = req.params.producer;
    var page = req.query.p || 1;
    var size = req.query.size || 50;

    if(allProducersMap[producer]){
        var data = allProducersMap[producer];
        var voterData = getVoters(votedProducers[data.owner]['voters']);
        var rows = pagination(page, size, voterData);
        res.json({
            producer: data,
            voters: rows,
            addLogs: votedProducers[data.owner]["addLogs"],
            bpinfo: producerInfoTable[producer],
            removeLogs: votedProducers[data.owner]["removeLogs"]
        });
    }
});


app.get('/getStatus', function(req, res, next){
    eos.getTableRows({
        json: true, code: "eosio", scope: "eosio",
        table: "global", table_key: "", limit: 1},
    (error, result) => {
        var row = result.rows[0];
        var percent = (row.total_activated_stake / 1e4 /1000011818*100).toFixed(3);
        res.json({
            percent_stacked: percent,
            producers: Object.keys(votedProducers).length,
            voters: Object.keys(allVoters).length,
            chain_state: row
        });
    })
});


app.get('/getVoteLogs', function(req, res, next){
    res.json(voterLogs);
});


app.get('/getVoteProxy', function(req, res, next){
    res.json(proxyVoters);
});



app.get('/voterCompare', function(req, res, next){
    var producers = req.query.producers || "";
    producers = producers.split(",");
    var dataRow = [];

    producers.forEach(function(producer){
        var data = allProducersMap[producer];
        var voterData = getVoters(votedProducers[data.owner]['voters']);
        var newData = [];
        voterData.forEach(function(voter){
            newData.push({
                account_name: voter.account_name,
                staked: voter.voter_info.staked,
            })
        })

        dataRow.push({
            producer: data,
            voters: newData
        })
    })

    res.json(dataRow);
});


var stream = require('stream');
var liner = new stream.Transform( { objectMode: true } )

liner._transform = function (chunk, encoding, done) {
  var data = chunk.toString()
  if (this._lastLineData) data = this._lastLineData + data

  var lines = data.split('\n')
  this._lastLineData = lines.splice(lines.length-1,1)[0]

  lines.forEach(this.push.bind(this))
  done()
}

liner._flush = function (done) {
     if (this._lastLineData) this.push(this._lastLineData)
     this._lastLineData = null
     done()
}


FILE_PATH = "./voter.log";
var source = fs.createReadStream(FILE_PATH)
source.pipe(liner)

liner.on('readable', function () {
    var line
    while (line = liner.read()) {
        try{
            newVoterBlock(line);
        }catch(e){
            console.log("newVoterBlock", "error", e)
        }
    }
})

FILE_PATH = "./voter.log";
Tail = require('tail').Tail;

tail = new Tail(FILE_PATH);

tail.on("line", function(data) {
    console.log("tail new", data);
    try{
        newVoterBlock(data);
    }catch(e){
        console.log("newVoterBlock", "error", e)
    }
});

tail.on("error", function(error) {
  console.log('ERROR: ', error);
});


var voteBlockCount = 0;


function newVoterBlock(data){

    voteBlockCount++;
   // console.log("newVoterBlock", voteBlockCount);

    if(voterLogs.length > 50){
        voterLogs.shift();
    }

    data = JSON.parse(data);
    voterLogs.push(data);

    needUpdateVoterTable[data.voter] = 1;

    if(typeof data.voter !== "string"){
        data.voter =  data.voter.account_name;
    }

    var voter = data.voter;
    var producers = data.producers;
    var timestamp = data.timestamp;
    var block_num = data.block_num;
    var proxy = data.proxy;

    allVoters[voter] = allVoters[voter] || {};
    allVoters[voter]['producers'] = allVoters[voter]['producers'] || {};

    if(!votersInfo[voter]){
        console.log("fetch voter info", voter);
        updateVotersList.push(voter);
    }

    if(proxy && !data.producers.length){
        proxyVoters[proxy] = proxyVoters[proxy] || {};
        proxyVoters[proxy]["voters"] = proxyVoters[proxy]["voters"] || {};
        proxyVoters[proxy]["voters"][voter] = proxyVoters[proxy]["voters"][voter] || 0;
        proxyVoters[proxy]["voters"][voter]++;
    }


    var voterIsProxy = proxyVoters[voter];
    if(voterIsProxy){
        console.log("voterIsProxy", "refresh voter info");
        Object.keys(proxyVoters[voter]["voters"]).forEach(function(proxyVoter){
            updateVotersList.push(proxyVoter);
            needUpdateVoterTable[proxyVoter] = 1;
        })
    }


    producers.forEach(function(producer){
        votedProducers[producer] = votedProducers[producer] || {};
        votedProducers[producer]["voters"] = votedProducers[producer]["voters"] || {};

        votedProducers[producer]["blocks"] = votedProducers[producer]["blocks"] || [];

        votedProducers[producer]["addLogs"] = votedProducers[producer]["addLogs"] || [];
        votedProducers[producer]["removeLogs"] = votedProducers[producer]["removeLogs"] || [];

        votedProducers[producer]["voters"][voter] = votedProducers[producer]["voters"][voter] || 0;
        votedProducers[producer]["voters"][voter]++;
        votedProducers[producer]["blocks"].push(data.block_num);

        if(votedProducers[producer]["addLogs"].length > 10){
            votedProducers[producer]["addLogs"].shift();
        }

        votedProducers[producer]["addLogs"].push({
            voter: voter,
            action: "add",
            block_num: block_num,
            timestamp: timestamp
        });

        allVoters[voter]['producers'][producer] = allVoters[voter]['producers'][producer] || {};
        allVoters[voter]['producers'][producer]['blocks'] =  allVoters[voter]['producers'][producer]['blocks'] || [];
        allVoters[voter]['producers'][producer]['blocks'].push(data.block_num);
    })

    allVoters[voter]['vote_time'] = timestamp;


    var allProducers = Object.keys(allVoters[voter]['producers']);
    var canceledProducers = [];

    allProducers.forEach(function(producer){
        if(producers.indexOf(producer) > -1){

        }else{
            canceledProducers.push(producer);
        }
    })

    canceledProducers.forEach(function(votedProducer){
        if(votedProducers[votedProducer]){
            var voters = votedProducers[votedProducer]["voters"];
            if(voters[voter]){
                if(votedProducers[votedProducer]["removeLogs"].length > 10){
                    votedProducers[votedProducer]["removeLogs"].shift();
                }
                votedProducers[votedProducer]["removeLogs"].push({
                    voter: voter,
                    action: "remove",
                    block_num: block_num,
                    timestamp: timestamp
                });
                delete voters[voter];
            }
        }

    })

    if(!producers.length){
        allVoters[voter]['vote_actions'] = allVoters[voter]['vote_actions'] || [];
        if(allVoters[voter]['vote_actions'].length > 5){
            allVoters[voter]['vote_actions'].shift();
        }
        allVoters[voter]['producers'] = {};
        delete allVoters[voter];
    }
}

app.use(compression());
app.listen(8080);
