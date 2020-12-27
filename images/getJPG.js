'use strict';

const AWS = require('aws-sdk');
const glob = require('glob');
const rimraf = require('rimraf');
const archiver = require('archiver');
const uuidv4 = require('uuid/v4');
const fs = require('fs');
const { PassThrough } = require('stream');
const { spawnSync, execSync } = require('child_process');
const { readFileSync, writeFileSync, existsSync } = require('fs');

const isLocal = (process.env.STAGE === 'dev') ? true : false;
const rawBucket = process.env.RAW_BUCKET;
const filesBucket = process.env.FILES_BUCKET;
const tasksTable = process.env.TASKS_TABLE;
const temporaryCredential = process.env.TEMPORARY_CREDENTIAL;
const serverRegion = process.env.REGION;

const gsBinary = (isLocal) ? 'gs' : '/opt/bin/gs';

exports.handler = async (event, context) => {
  console.log(serverRegion);

  if (event.source === 'serverless-plugin-warmup') {
    console.log('WarmUP - Lambda is warm!');
    return 'Lambda is warm!';
  }
  if (!event.Records) {
    console.warn("not an s3 invocation!");
    return;
  }

  const startTime = new Date().toJSON(); 
  const sts = new AWS.STS({
    apiVersion: '2011-06-15', 
    endpoint: `https://sts.${serverRegion}.amazonaws.com`, 
    region: serverRegion
  });
  const data = await sts.assumeRole({
      DurationSeconds: 900,
      RoleArn: temporaryCredential,
      RoleSessionName: 'GonvertPDFtoJPGRole',
    }).promise();

  const accessParams = {
    accessKeyId: data.Credentials.AccessKeyId,
    secretAccessKey: data.Credentials.SecretAccessKey,
    sessionToken: data.Credentials.SessionToken,
  };

  const s3 = (!isLocal) ? 
    new AWS.S3({ 
      ...accessParams,
      apiVersion: '2006-03-01',
      signatureVersion: 'v4', 
      region: serverRegion }) :
    new AWS.S3({
      s3ForcePathStyle: true,
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      endpoint: new AWS.Endpoint('http://localhost:4568'),
    });
 
  const ddbDocClient = (!isLocal) ? 
    new AWS.DynamoDB.DocumentClient({ 
      ...accessParams, 
      apiVersion: '2012-08-10',
      convertEmptyValues: true,
      region: serverRegion }) :
    new AWS.DynamoDB.DocumentClient({
      region: 'localhost',
      endpoint: 'http://localhost:8001'
    });

  for (const record of event.Records) {
    if (!record.s3) {
      console.log("not an s3 invocation!");
      continue;
    }

    let fileSize = 0;
    const outputFileList = [];
    const consoleList = { 'fileList': [], 'archiveStartTime': '', 'archiveEndTime': '', 'archiveResult': [], 'savingIntoDBStartTime': '', 'savingIntoDBEndTime': '', 'convertStartTime': '', 'convertEndTime': '' };
    
    // Create a folder based on file ID to store raw and result files
    const uuId = `${uuidv4()}`;
    const documentId = uuId.replace(/-/g, '');
    const rawFileDir = `/tmp/raw/pdftojpg/${documentId}`;
    const resultFileDir = `/tmp/result/pdftojpg/${documentId}`;

    if (!existsSync(rawFileDir)) {
      execSync(`mkdir -p ${rawFileDir}`);
    }
    if (!existsSync(resultFileDir)) {
      execSync(`mkdir -p ${resultFileDir}`);
    }

     // Create zip file and send it to S3 bucket
    const archive = () => {
      return new Promise(async (resolve, reject) => {
        const streamArchiver = archiver('zip');
        const outputStream = new PassThrough();
        const outputFilePath = `${documentId}-images.zip`;

        s3.upload({ 
          Bucket: filesBucket,
          Key: outputFilePath,
          Body: outputStream
        }, (error, data) => { 
          if (error) {
            reject(error);
          } else {
            resolve({
              s3Bucket: data.Bucket,
              fileKey: data.Key,
              fileSize: streamArchiver.pointer()
            });
          }
        });

        streamArchiver.pipe(outputStream);
        const convertedFileList = glob.sync(`${resultFileDir}/*.jpg`);
        let index = 1;

        consoleList['fileList'] = convertedFileList;

        for (let convertedFile of convertedFileList) {
          const shortFileName = `${index.toString().padStart(3, '0')}.jpg`;
          const newFileName = `${documentId}-${shortFileName}`;
          const fileReadStream = readFileSync(convertedFile);

          outputFileList.push(newFileName);

          await s3
            .upload({
              Bucket: filesBucket,
              Key: `${newFileName}`,
              Body: fileReadStream
            })
            .promise();

          streamArchiver.append(fileReadStream, { name: shortFileName });
          index += 1;
        }

        outputFileList.push(outputFilePath);
        streamArchiver.finalize();
      });
    }

    // Convert the PDF into images
    const convertFile = (objectKey, keyIndex) => {
      return new Promise(async(resolve, reject) => {

        const params = {
          Bucket: filesBucket,
          Key: objectKey
        };

        s3.getObject(params, function(err, s3Object) {
          if (err) {
            console.warn('File not found');
            resolve('continue');
          }

          fileSize += parseFloat(s3Object.ContentLength) / 1000;

          const targetFile = `${rawFileDir}/${objectKey}`;
          const destinationPath = `${resultFileDir}/${keyIndex}_%03d.jpg`;

          writeFileSync(`${targetFile}`, s3Object.Body);

          spawnSync(
            `${gsBinary}`,
            [
              '-dQUIET',
              '-dSAFER',
              '-dBATCH',
              '-dNOPAUSE',
              '-dNOPROMPT',
              '-sDEVICE=jpeg',
              '-dJPEGQ=85',
              '-dTextAlphaBits=4',
              '-dGraphicsAlphaBits=4',
              '-dUseCropBox',
              '-r600',
              '-dDownScaleFactor=3',
              '-dAutoRotatePages=/None',
              '-sOutputFile=' + destinationPath,
              targetFile
            ],
            { stdio: 'inherit' }
          );

          resolve('ok');
        });        
      });
    }

    // Delete all /tmp folders and JSON file from S3 bucket
    const removeFolder = () => {
      return new Promise(async (resolve, reject) => {
        rimraf.sync(resultFileDir);
        rimraf.sync(rawFileDir);

        resolve('ok');
      })
    } 

    try {
      // read from the json file that triggered the event
      const jsonFilePath = (record.s3.object.key.indexOf('pdftojpg') > -1) ? record.s3.object.key : `pdftojpg/${record.s3.object.key}`;

      const targetFileName = jsonFilePath.split('pdftojpg/').pop();
      const id = targetFileName.split('.').slice(0, -1).join('.');
      const taskId = id.substr(0,8) + '-' + id.substr(8,4) + '-' + id.substr(12,4) + '-' + id.substr(16,4) + '-' + id.substr(20);
      
      const jsonObject = await s3
        .getObject({
          Bucket: record.s3.bucket.name,
          Key: jsonFilePath
        })
        .promise();

      consoleList['convertStartTime'] = new Date().toJSON();
      const json = JSON.parse(jsonObject.Body.toString());
      const promises = json.input_tokens.map(convertFile);
      await Promise.all(promises);
      consoleList['convertEndTime'] = new Date().toJSON();

      consoleList['archiveStartTime'] = new Date().toJSON();
      const archiveResult = await archive();
      consoleList['archiveEndTime'] = new Date().toJSON();
      consoleList['archiveResult'] = archiveResult;

      // Update the content into the Files table
      consoleList['savingIntoDBStartTime'] = new Date().toJSON();

      const completionTime = new Date().toJSON();
      const params = {
        TableName: tasksTable,
        Key:{
          'task_id': taskId,
        },
        UpdateExpression: 'set output_files = :f, started_time = :s, completed_time = :c, input_filesize = :i, success = :u, output_filesize = :o',
        ExpressionAttributeValues:{
          ':f': outputFileList,
          ':s': startTime,
          ':c': completionTime,
          ':i': Math.floor(fileSize),
          ':o': Math.floor(parseFloat(archiveResult.fileSize) / 1000),
          ':u': true
        },
        ReturnValues:"UPDATED_NEW"
      };
      // FileSize in KB

      await ddbDocClient
        .update(params)
        .promise();

      consoleList['savingIntoDBEndTime'] = new Date().toJSON();
      
      await removeFolder();

      console.log('Convert start time: ' + consoleList['convertStartTime']);
      console.log('Convert end time: ' + consoleList['convertEndTime']);
      console.log('Converted files list: ' + consoleList['fileList']);
      console.log('Archive start time: ' + consoleList['archiveStartTime']);
      console.log('Archive end time: ' + consoleList['archiveEndTime']);
      console.log('Archive result: ' + JSON.stringify(consoleList['archiveResult']));
      console.log('Saving into DB start time: ' + consoleList['savingIntoDBStartTime']);
      console.log('Saving into DB end time: ' + consoleList['savingIntoDBEndTime']);

    } catch (error) {
      console.error(error);
    } 
  }
};
