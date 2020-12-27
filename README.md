# Uploading Objects to S3 Using One-Time Presigned URLs

See [Uploading Objects to S3 Using One-Time Presigned URLs @ Medium](https://medium.com/@laardee/uploading-objects-to-s3-using-one-time-presigned-urls-4374943f0801)

## Introduction

If you have used SmallPDF before, here is the sample demo project for converting PDF to JPG/PNG using AWS Lambda functions. AWS Lambda will automatically run the converting script on S3 bucket whenever there is a create object event. The project is no longer maintained.

## Setup

Edit the serverless.env.yml file and change the name of the bucket, DynamoDB table name, and change the temporary credential value based on your setup on your account.

## Requirements

Ghostscript layer is required to run the converting script. Please visit [https://github.com/shelfio/ghostscript-lambda-layer](https://github.com/shelfio/ghostscript-lambda-layer) for integrating the Ghostscript binary into the lambda function.

## Deployment

Use Serverless Framework for deployment. Install the dependecies with `npm install` and then run `sls deploy` in the project root to start the deployment.

```bash
npm install
```

Then using serverless run the following script.

```bash
sls deploy
```

## License
[MIT](https://choosealicense.com/licenses/mit/)
