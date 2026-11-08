import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { serverRoot } from '../src/config.js';
export async function makeFixtures() {
  const jpeg = await fs.readFile(path.join(serverRoot,'../assets/clothes/clothing-001.jpg'));
  const pixels=Buffer.alloc(96*96*3);
  for(let y=0;y<96;y++)for(let x=0;x<96;x++){const i=(y*96+x)*3,color=((x>>4)+(y>>4))%2?[163,79,105]:[246,231,237];pixels.set(color,i);}
  const png=await sharp(pixels,{raw:{width:96,height:96,channels:3}}).png().toBuffer();
  function sizedPng(size){
    const payloadSize=size-png.length-12,chunk=Buffer.alloc(payloadSize+12,120);
    chunk.writeUInt32BE(payloadSize,0);chunk.write('tEXt',4);chunk.write('Comment\0',8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4,8+payloadSize)),8+payloadSize);
    return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
  }
  return {jpeg,png,sizedPng};
}
