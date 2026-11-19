'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {server, youtubeQuotaDay,validId, validHandle, validVideoId}=require('./server');

test('유효한 채널/영상 ID와 핸들을 구분',()=>{
  assert.equal(validId('UC'+'X'.repeat(22)),true);
  assert.equal(validId('UCwrong'),false);
  assert.equal(validHandle('@abc.test'),true);
  assert.equal(validHandle('https://youtube.com/@abc'),false);
  assert.equal(validVideoId('Q'.repeat(11)),true);
});
test('태평양 표준시 쿼터 일자를 사용',()=>{
  assert.equal(youtubeQuotaDay(new Date('2026-11-19T04:00:00Z')),'2026-11-18');
});
test('홈페이지와 API가 응답하고 비밀키를 공개하지 않음',async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  try {
    const homepage=await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(homepage.status,200);
    assert.match(await homepage.text(),/KINGSMAN LABEL 1팀 뱅온 현/);
    const payload=await(await fetch(`http://127.0.0.1:${port}/api/live`)).json();
    assert.equal(payload.members.length,24);
    assert.equal(new Set(require("./config/members.json").map(m => m.channel)).size,24);
    assert.equal(payload.mode,'needs_api_key');
    assert.equal('key' in payload,false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status,404);
  }finally{await new Promise(r=>server.close(r));}
});
