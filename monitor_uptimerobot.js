const AWS = require('aws-sdk');
AWS.config.region = 'ap-southeast-2';
const docClient = new AWS.DynamoDB({region: 'ap-southeast-2'});
const ssm = new AWS.SSM();
const sns = new AWS.SNS();


const GetDataFromSSM = (ssm_key) => new Promise((resolve, reject) => {
    var params = {
      Name: `${ssm_key}`,
      WithDecryption: true 
    };

    ssm.getParameter(params, (err, data) => {
      if (err) {
        //   console.log(err, err.stack); // an error occurred
          reject(err)
      }
      else     {
        //  console.log(data);           // successful response
        resolve(data)
         
      }
    });
});

const UptimeRobotRequest = (api_key) => new Promise((resolve, reject) => {
    var qs = require("querystring");
    var http = require("https");

    var request_options = {
      method: "POST",
      hostname: "api.uptimerobot.com",
      port: null,
      path: "/v2/getMonitors",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cache-control": "no-cache"
      }
    }
    var req = http.request(request_options, res => {
      var chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        var body = Buffer.concat(chunks);
        var str = body.toString();
        resolve(str);
      });
    });
    const params = qs.stringify({ api_key, format: 'json', logs: '0'});
    req.write(params);
    req.end();
    //TODO: if error, pass exception or error to reject function
}).then(JSON.parse);

const publishToSNS = (monitors_by_id) => (alert_monitors) => {
    let monitors_details = ''
    if (alert_monitors.length > 0){
        
        alert_monitors.forEach(id => monitors_details += '[ ' + id + ':' +  monitors_by_id[id].friendly_name + ' ]' );
        let snsMessage = `UptimeRobot monitors  ${monitors_details}  is/are down.`
        
        var uptimerobot_sns_arn
        let uptimerobot_sns_arn_ssm_string_name = 'uptimerobot_sns_arn'
        GetDataFromSSM(uptimerobot_sns_arn_ssm_string_name)
        .then(data => {
            uptimerobot_sns_arn = data.Parameter.Value
            
            return uptimerobot_sns_arn
            
        })
        .then((uptimerobot_sns_arn) =>{
            
            sns.publish({
                    "Subject": "UptimeRobot Alerts",
                    "Message": `${snsMessage}`,
                    "TopicArn": `${uptimerobot_sns_arn}`
                    
    
            }, function(err, data) {
                if(err){
                    console.log(err.stack);
                    return;
                }else{
                    console.log
                }
                
            });
            
        });

        
    }
    
    return alert_monitors;
    
}
const create_alerted_status_mapping = (monitors_by_id) => (alert_monitors) => {
        let status_mapping= {}
        const group_alert_ids = alert_monitors.reduce((obj, id) => {
            const monitor = monitors_by_id[id];
            
            let status = 'alerted';
            if(obj[status] === undefined) {
                    obj[status] = [];
            }
            obj[status].push(id);
            
            return obj;
        }, status_mapping)
        return status_mapping;
}

const fetchFromDynamoDb = () => new Promise((resolve, reject) => {
    docClient.scan({ TableName: 'uptimerobot_monitors' }, (err, data) => {
        if(err) {
            reject(err);
        } else {
            resolve(data);
        }
    })
});


const create_params = (status) => (monitor) => {
        
        let new_params = {}
        switch(status) {
            case 'down':
            case 'new_down':
            case 'up':
            case 'new_up':
                new_params = {
                               PutRequest: { 
                                   Item: {
                                            "id": {
                                                N: `${monitor.id}`
                                            },
                                            "monitor_name": {
                                                S: monitor.friendly_name
                                                
                                            },
                                            "status": {
                                                S: status
                                                
                                            },
                                            "alerted": {
                                                BOOL: false
                                                
                                            }
                                        }
                                    }
                           }
                break;
            
            case 'alerted':
                new_params = {
                               PutRequest: { 
                                   Item: {
                                            "id": {
                                                N: `${monitor.id}`
                                            },
                                            "monitor_name": {
                                                S: monitor.friendly_name
                                                
                                            },
                                            "status": {
                                                S: status
                                                
                                            },
                                            "alerted": {
                                                BOOL: true
                                                
                                            }
                                        }
                                    }
                           }
                break;
        }

        return new_params
}

const createDynamoRequest = (status, applicable_monitors) => {
    const params_list = applicable_monitors.map(create_params(status));
    return Promise.resolve(params_list);
}

const processBatchWriteItemsCallback = (resolve, reject) => function(err, data) {
    if (err) {
        reject(err);
      } else {
          if (data.UnprocessedItems.length > 0){
              params = {};
              params.RequestItems = data.UnprocessedItems;
            
              docClient.batchWriteItem(params, processBatchWriteItemsCallback(resolve, reject));
          } else {
              resolve();
          }
        console.log("Success", data);
      }
}

const executeBatchWrite = (params) => {
    
    return new Promise((resolve, reject) => {
        docClient.batchWriteItem(params, processBatchWriteItemsCallback(resolve, reject));
    });
}

const createDynamoRequests = (monitors_by_id) => (status_mapping) => {
        const requests = Object.keys(status_mapping).map(status => {
        
        const applicable_monitors = status_mapping[status].map(id => monitors_by_id[id]);
        
        return createDynamoRequest(status, applicable_monitors);    
    
        })
        
        if(requests.length === 0) {
            return Promise.resolve(status_mapping)
        }

        return Promise.all(requests)
                  .then(results => {
                      const put_requests = [].concat.apply([], results);
                    
                      let params = {
                        "RequestItems": {
                            "uptimerobot_monitors": put_requests
                        },
                        "ReturnConsumedCapacity": "TOTAL"
                      };
                    
                      return params;
                  })

                  .then(executeBatchWrite)
                  .then(() => status_mapping);
}

let unalerted_monitors = [];

exports.handler = (event, context, callback) => {

  
 

    var api_keys_array;
    let api_keys_ssm_string_name = 'uptimerobot_monitor_api_keys';
    GetDataFromSSM(api_keys_ssm_string_name)
        .then(data => {
            ssm_value_string = data.Parameter.Value
            var api_keys_array = ssm_value_string.split(',');
            console.log(api_keys_array)
            return api_keys_array
            
        })
        .then((api_keys_array) =>{

       Promise.all(api_keys_array.map(UptimeRobotRequest))
            .then(results => {
                const all_monitors = [].concat.apply([], results.map(d => d.monitors));
                const monitors_by_id = all_monitors.reduce((obj, monitor) => {
                    obj[monitor.id] = monitor;
                    return obj;
                }, {})
    
                fetchFromDynamoDb()
                    .then(data => { // result from get dynamo db table

                        // Group data
                        unalerted_monitors.length = 0;
                        const dynamo_by_id = data.Items.reduce((obj, d) => {
                            obj[d.id.N] = d;
                            
                            if(d.alerted.BOOL === false) {
                                unalerted_monitors.push(d.id.N);
                            }
                            return obj;
                        }, {})
                        
                        console.log("unalerted_monitors: " + unalerted_monitors)
    
                        let status_mapping = { }
    
                        const dynamo_ids = Object.keys(dynamo_by_id);
                        const monitor_ids = Object.keys(monitors_by_id);
                        const new_ids = monitor_ids.filter(id => dynamo_ids.indexOf(id) === -1); // monitor_ids - dynamo_ids
                        
    
                        const grouped_new_ids = new_ids.reduce((obj, id) => {
                            const monitor = monitors_by_id[id];
                            let status = 'new';
                            if(monitor.status === 2) status += '_up';
                            else if([8,9].indexOf(monitor.status) !== -1) status += '_down';
    
                            if(status !== 'new') {
                                if(obj[status] === undefined) {
                                    obj[status] = [];
                                }
                                obj[status].push(id);
                            }
    
                            return obj;
                        }, status_mapping)
                        
                        const grouped_old_ids = dynamo_ids.reduce((obj, id) => {
                        
                            const monitor = monitors_by_id[id];
                        
                            const dynamo = dynamo_by_id[id];
                        
                            let status = '';
                            if(monitor.status === 2 ) status = 'up';
                            else if([8,9].indexOf(monitor.status) !== -1 && dynamo.status.S !='alerted' )  status = 'down';
                            else if(dynamo.status.S === 'alerted') status = 'alerted';
                            
                            if(status !== '') {
                                
                                if(obj[status] === undefined) {
                                    obj[status] = [];
                                }
                                obj[status].push(id);
                                
                            }
                            return obj;
                        }, status_mapping)
    
                        return status_mapping;
                    })
                    .then(createDynamoRequests(monitors_by_id))
                    .then(status_mapping => {
                        let alert_monitors = []
                        // use status mappng and above array to decided which monitors need to have an sns alert and be updated iin dynamo

                        
                        if(status_mapping.new_down != undefined && status_mapping.new_down.length > 0){
                            alert_monitors = status_mapping.new_down;
                        }
                        
                        if(status_mapping.down != undefined && status_mapping.down.length > 0 ){
                            status_mapping.down
                              .filter(id => unalerted_monitors.indexOf(id) !== -1)
                              .forEach(id => alert_monitors.push(id));
                            
                        }
                        console.log("alert_monitors")
                        console.log(alert_monitors)
                        
                        return alert_monitors
                    })
                    .then(publishToSNS(monitors_by_id))
                    .then(create_alerted_status_mapping(monitors_by_id))
                    .then(createDynamoRequests(monitors_by_id));
            })
            .catch(console.error) // TODO: proper error handling 
        }).catch(console.error) // TODO: proper error handling 

     
    
};