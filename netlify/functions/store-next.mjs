import adapter from './lib/store-handler.cjs';
import database from './lib/store-db.cjs';
import {getDatabase} from '@netlify/database';
import sharp from 'sharp';
import photos from './lib/affiliate-photos.cjs';

database.configureHostedDatabase(getDatabase);
photos.configureImageProcessor(sharp);

// The modern runtime supplies Netlify.env, including the branch database URL.
export default async function store(request) {
 const url=new URL(request.url);
 const result=await adapter.handler({
  httpMethod:request.method,
  queryStringParameters:Object.fromEntries(url.searchParams),
  headers:Object.fromEntries(request.headers),
  body:['GET','HEAD'].includes(request.method)?'':await request.text(),
  isBase64Encoded:false
 });
 return new Response(result.isBase64Encoded?Buffer.from(result.body,'base64'):result.body,{
  status:result.statusCode,headers:result.headers
 });
}
