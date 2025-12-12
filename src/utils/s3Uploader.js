// s3Upload.js
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { s3Client } from '../../config/s3Config.js';
import { pipeline as streamPipeline } from 'stream';
import { promisify } from 'util';
const pipeline = promisify(streamPipeline);

/**
 * Uploads a file to S3
 */
async function uploadFile(filePath, bucketName, key = null, acl = 'authenticated-read') {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found.', key };

    const fileStream = fs.createReadStream(filePath);
    const fileName = key || path.basename(filePath);
    const contentType = mime.lookup(filePath) || 'application/octet-stream';

    const params = {
        Bucket: bucketName,
        Key: fileName,
        Body: fileStream,
        ContentType: contentType,
    };

    try {
        const command = new PutObjectCommand(params);
        await s3Client.send(command);

        const region = process.env.AWS_REGION || 'eu-west-2';
        const url = `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(fileName)}`;

        return { success: true, url, key: fileName, message: 'File uploaded successfully' };
    } catch (error) {
        console.error('Error uploading to S3:', error);
        return { success: false, error: error.message, key: fileName };
    }
}

/**
 * Uploads a JSON object to S3
 */
async function uploadJson(data, bucketName, key, acl = 'authenticated-read') {
    const jsonKey = key.endsWith('.json') ? key : `${key}.json`;

    const params = {
        Bucket: bucketName,
        Key: jsonKey,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
    };

    try {
        const command = new PutObjectCommand(params);
        await s3Client.send(command);

        const region = process.env.AWS_REGION || 'eu-west-2';
        const url = `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(jsonKey)}`;

        return { success: true, url, key: jsonKey, message: 'JSON uploaded successfully' };
    } catch (error) {
        console.error('Error uploading JSON to S3:', error);
        return { success: false, error: error.message, key: jsonKey };
    }
}

/**
 * Check if a file exists on S3
 */
async function checkS3FileExists(bucketName, key) {
    try {
        const command = new HeadObjectCommand({ Bucket: bucketName, Key: key });
        await s3Client.send(command);
        return true;
    } catch (err) {
        if (err.name === 'NotFound') return false;
        throw err;
    }
}

/**
 * Download a file from S3
 */
async function downloadFileFromS3(bucketName, key, localPath) {
    try {
        const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
        const response = await s3Client.send(command);
        await pipeline(response.Body, fs.createWriteStream(localPath));
        return { success: true, path: localPath };
    } catch (error) {
        console.error(`Error downloading ${key} from S3:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Delete a file from S3
 */
async function deleteFileFromS3(bucketName, key) {
    try {
        const command = new DeleteObjectCommand({ Bucket: bucketName, Key: key });
        await s3Client.send(command);
        return { success: true };
    } catch (error) {
        console.error(`Error deleting ${key} from S3:`, error);
        return { success: false, error: error.message };
    }
}

export { uploadFile, uploadJson, checkS3FileExists, downloadFileFromS3, deleteFileFromS3 };
