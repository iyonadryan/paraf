import { MemoryStore } from '@paraf/core';
import { describeStoreContract } from '../src';

describeStoreContract('MemoryStore', { create: () => new MemoryStore() });
