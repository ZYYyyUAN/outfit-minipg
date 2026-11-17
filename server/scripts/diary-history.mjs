import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..'),base=path.join(root,'docs/evidence/P6');
const hash=v=>createHash('sha256').update(v).digest('hex');
const [mode,runId,sourceRun]=process.argv.slice(2);
if(!mode||mode==='--help')console.log('只读补充历史保护 --capture <唯一runId>；--check <唯一runId> <captureRunId>。递归包含未跟踪/忽略P1～P5证据和发布报告，不回填起点覆盖范围。');
else{
 assert.ok(['--capture','--check'].includes(mode));assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);if(mode==='--check')assert.match(sourceRun,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const dir=path.join(base,runId);await fs.mkdir(dir);const files={};
 for(const e of await fs.readdir(path.join(root,'docs/evidence'),{withFileTypes:true}))if(e.isDirectory()&&/^P[1-5](?:-|$)/.test(e.name)){
  async function walk(folder){for(const child of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,child.name);if(child.isDirectory())await walk(file);else files[path.relative(root,file).replaceAll('\\','/')]=hash(await fs.readFile(file));}}
  await walk(path.join(root,'docs/evidence',e.name));
 }
 const originalP5=['docs/P5执行与验收记录.md','server/scripts/verify-outfits.mjs','server/scripts/outfit-business-proof.mjs','server/scripts/verify-outfit-manual.mjs','server/test/outfit-business-proof.test.mjs'];for(const f of originalP5)files[f]=hash(await fs.readFile(path.join(root,f)));
 const historical=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/historical-release-hashes.json')));
 for(const [file,sha]of Object.entries(historical))assert.equal(files[file],sha,'PRIOR_P5_HISTORY:'+file);
 const tracked=new Set(execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0'));
 if(mode==='--check'){const before=JSON.parse(await fs.readFile(path.join(base,sourceRun,'history.json')));assert.deepEqual(files,before.files,'ALL_HISTORY_AND_EXTERNAL_P5_FILES');}
 const report={mode,runId,capturedAt:new Date().toISOString(),coverageStartsNow:true,initial729BaselineNotRetrofitted:true,priorP5HistoricalReleaseHashesMatched:Object.keys(historical).length,fileCount:Object.keys(files).length,untrackedOrIgnoredCount:Object.keys(files).filter(f=>!tracked.has(f)).length,files};await fs.writeFile(path.join(dir,'history.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({runId,passed:true,files:report.fileCount,untrackedOrIgnored:report.untrackedOrIgnoredCount,priorHistoryMatched:report.priorP5HistoricalReleaseHashesMatched}));
}
