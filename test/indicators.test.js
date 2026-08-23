import test from 'node:test';import assert from 'node:assert/strict';import { ema, rsi, macd, atr } from '../src/indicators/index.js';import { analyze } from '../src/strategy/strategy.js';
test('EMA seeds with SMA and follows trend',()=>{const out=ema([1,2,3,4,5],3);assert.equal(out[2],2);assert.equal(out[4],4)});
test('RSI reaches 100 in a rising market',()=>assert.equal(rsi(Array.from({length:20},(_,i)=>i+1),14).at(-1),100));
test('MACD and ATR preserve input length',()=>{const values=Array.from({length:80},(_,i)=>100+i);assert.equal(macd(values).histogram.length,80);const candles=values.map((v,i)=>({high:v+2,low:v-2,close:v,open:v,volume:i}));assert.equal(atr(candles).length,80)});
test('strategy action respects the configured score threshold',()=>{const candles=Array.from({length:80},(_,i)=>({high:100+i,low:98+i,close:99+i,open:99+i,volume:100+i}));const result=analyze(candles,true,101);assert.equal(result.action,'WAIT')});
