/** Client delivery is at-most-once, including cancellation between claim and start. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DesktopClientTransport } from '../src/desktop-client-transport.ts'

test('authenticated Fetch routes preserve RPC correlation and refuse malformed envelopes', async () => {
  const transport = new DesktopClientTransport(1000, 500)
  const signal = new AbortController().signal
  const rpcId = randomUUID(), endpoint = 'ops-browser/status'
  const envelope = {type:'client-request',rpcId,method:endpoint,payload:{}}
  const request = (body: unknown, contentType = 'application/json') => new Request('http://127.0.0.1/api/' + endpoint,
    {method:'POST',headers:{'content-type':contentType},body:JSON.stringify(body)})
  try {
    const response = await transport.fetch(endpoint,request(envelope),signal)
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{type:'server-response',rpcId,result:{ok:true,value:{live:false,pending:0}}})
    for (const malformed of [null,[],{...envelope,method:'ops-browser/poll'},{...envelope,rpcId:'invalid'},{...envelope,type:'other'}]) {
      assert.equal((await transport.fetch(endpoint,request(malformed),signal)).status,400)
    }
    assert.equal((await transport.fetch(endpoint,request(envelope,'text/plain'),signal)).status,415)
    const rejected = await transport.fetch('ops-browser/poll',request({...envelope,method:'ops-browser/poll',payload:{client:'secret'}}),signal)
    const result = await rejected.json() as {result:{ok:boolean,error:{message:string}}}
    assert.equal(result.result.ok,false)
    assert.equal(result.result.error.message.includes('secret'),false)
  } finally { transport.dispose() }
})

test('authenticated poll claims once and start cannot be repeated', async () => {
  const transport = new DesktopClientTransport(1000, 500)
  const client = randomUUID(), signal = new AbortController().signal
  try {
    const poll = transport.handle('ops-browser/poll', {client}, signal)
    const response = transport.request({action:'evaluate',session:'one',script:'1'}, signal)
    const job = await poll as {id:string}
    assert.deepEqual(await transport.handle('ops-browser/start', {client,id:job.id}, signal), {accepted:true})
    assert.deepEqual(await transport.handle('ops-browser/start', {client,id:job.id}, signal), {accepted:false})
    await assert.rejects(transport.handle('ops-browser/start', {client:randomUUID(),id:job.id}, signal), /BUSY/)
    await transport.handle('ops-browser/result', {client,id:job.id,value:42}, signal)
    assert.equal(await response, 42)
    assert.deepEqual(await transport.handle('ops-browser/result', {client,id:job.id,value:99}, signal), {accepted:false})
  } finally { transport.dispose() }
})

test('cancellation removes a claimed command before start and rejects late results', async () => {
  const transport = new DesktopClientTransport(1000, 500)
  const client = randomUUID(), signal = new AbortController().signal, cancellation = new AbortController()
  try {
    const poll = transport.handle('ops-browser/poll', {client}, signal)
    const response = transport.request({action:'evaluate',session:'one',script:'send()'}, cancellation.signal)
    const rejected = assert.rejects(response, /CANCELLED/)
    const job = await poll as {id:string}
    cancellation.abort(); await rejected
    assert.deepEqual(await transport.handle('ops-browser/start', {client,id:job.id}, signal), {accepted:false})
    assert.deepEqual(await transport.handle('ops-browser/status', {}, signal), {live:true,pending:0})
  } finally { transport.dispose() }
})

test('unconnected transport and malformed client identities are refused', async () => {
  const transport = new DesktopClientTransport(1000, 500)
  try {
    await assert.rejects(transport.request({action:'attach'}, new AbortController().signal), /UNAVAILABLE/)
    await assert.rejects(transport.handle('ops-browser/poll', {client:'invalid'}, new AbortController().signal), /INVALID/)
  } finally { transport.dispose() }
})

test('unloading rejects pending delivered work without returning it to the queue', async () => {
  const transport = new DesktopClientTransport(1000, 500)
  const client = randomUUID(), signal = new AbortController().signal
  const poll = transport.handle('ops-browser/poll', {client}, signal)
  const response = transport.request({action:'evaluate',session:'one'}, signal)
  const rejected = assert.rejects(response, /UNAVAILABLE/)
  await poll; transport.dispose(); await rejected
})
