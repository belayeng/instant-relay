
import type {
  BroadcastMessage,
  Callback,
  NodeFactory,
  InternalNode,
  Message,
  AddNodeOpts,
  SendMessage,
} from './types';

import fastq from 'fastq';
import debug from 'debug';
import { forEach } from './utils';

const dbg = debug('instant-relay');

const makeSend = <M extends Message>(nodes: Record<string, InternalNode<M>>, senderId: string): SendMessage<M> => {
  return (recipientId: string, message: M, done: Callback) => {
    if (recipientId === senderId) {
      throw new Error(`Node "${senderId}" tried to send a message to itself`);
    }
    const recipient = nodes[recipientId];
    if (!recipient) {
      throw new Error(`Unknown node with id "${recipientId}"`);
    }
    dbg('SEND | from', senderId, 'to', recipient.id, 'msg', message.id, 'type', message.type);
    recipient.push(message, done);
  };
};

const makeBroadcast = <M extends Message>(nodes: Record<string, InternalNode<M>>, senderId: string): BroadcastMessage<M> => {
  return (message: M, done: Callback) => {
    forEach(nodes, (recipient, next) => {
      if (recipient.id !== senderId) {
        dbg('BCST | from', senderId, 'to', recipient.id, 'msg', message.id, 'type', message.type);
        recipient.push(message, next);
        return;
      }
      next();
    }, done);
  };
};

export const makeNode = <M extends Message, O>(
  nodes: Record<string, InternalNode<M>>,
  id: string,
  factory: NodeFactory<M, O>,
  opts: AddNodeOpts & O,
): InternalNode<M> => {

  const throttle = opts.throttle || (len => len);
  const concurrency = opts.concurrency || 1;
  const highWaterMark = opts.highWaterMark || 16;

  const send = makeSend(nodes, id);
  const broadcast = makeBroadcast(nodes, id);
  const handleMessage = factory(send, broadcast, { ...opts, id });

  let handlingQueueLength = 0;

  const handlingQueue = fastq((msg: M, done: fastq.done) => {
    handleMessage(msg, (err) => {
      dbg('PROC | node', id, 'msg', msg.id, 'type', msg.type);
      handlingQueueLength -= 1;
      if (err) {
        throw err;
      }
      done(null);
    });
  }, concurrency);

  const incomingQueue = fastq((msg: M, done: fastq.done) => {
    if (handlingQueueLength < highWaterMark) {
      handlingQueue.push(msg);
      handlingQueueLength += 1;
      Promise.resolve(null).then(done);
    } else {
      setTimeout(() => {
        handlingQueue.push(msg);
        handlingQueueLength += 1;
        done(null);
      }, throttle(handlingQueueLength));
    }
  }, 1);

  const push = (message: M, done: Callback) => {
    incomingQueue.push(message, done);
  };

  return { id, push };

};