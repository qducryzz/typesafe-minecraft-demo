const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const ids=['decisionId','recordId','requestId','observationId','toolId','rconCommandId','runId','httpRequestId','connectionId','searchId','spanId'];
async function* lines(file){
  const input=fs.createReadStream(file,{encoding:'utf8'}),reader=readline.createInterface({input,crlfDelay:Infinity});
  let number=0,streamError;
  input.on('error',error=>{streamError=error;reader.close();});
  try{for await(const line of reader){number++;if(!line.trim())continue;
    try{yield JSON.parse(line);}catch{throw new Error(`Invalid or incomplete JSON at ${path.basename(file)}:${number}; retry after the writer finishes.`);}
  }if(streamError)throw streamError;}finally{reader.close();input.destroy();}
}
async function readArchive(manifestFile,id){
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.schemaVersion!==2||!manifest.sessionId||!manifest.files?.trace||!manifest.files?.decisions)throw new Error('A schemaVersion 2 archive manifest is required; legacy logs cannot be joined reliably.');
  const base=path.dirname(path.resolve(manifestFile)),rounds=new Set(),matches=row=>ids.some(key=>row[key]===id)||row.eventId===id||row.traceEventId===id;
  const decisionFile=path.resolve(base,manifest.files.decisions),traceFile=path.resolve(base,manifest.files.trace);
  const verify=row=>{if(row.sessionId!==manifest.sessionId)throw new Error('Archive files belong to different sessions');};
  for await(const row of lines(decisionFile)){verify(row);if(matches(row)&&row.decisionId)rounds.add(row.decisionId);}
  // Also support a request/tool start whose process died before a summary existed.
  for await(const row of lines(traceFile)){verify(row);if(matches(row)&&row.decisionId)rounds.add(row.decisionId);}
  const decisions=[],events=[];
  for await(const row of lines(decisionFile))if(matches(row)||rounds.has(row.decisionId))decisions.push(row);
  for await(const row of lines(traceFile))if(matches(row)||rounds.has(row.decisionId))events.push(row);
  if(!decisions.length&&!events.length)throw new Error('No matching ID in this archive');
  return {sessionId:manifest.sessionId,files:manifest.files,decisions,events};
}
if(require.main===module){
  const [manifestFile,id]=process.argv.slice(2);
  if(!manifestFile||!id){console.error('Usage: node scripts/read-archive.cjs <archive.json> <decisionId|recordId|requestId|runId>');process.exitCode=1;}
  else readArchive(manifestFile,id).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={readArchive};
