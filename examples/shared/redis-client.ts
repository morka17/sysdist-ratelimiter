import Redis from 'ioredis';
import { getRedisUrl } from './env.js';

export function createRedisClient(): Redis {
  return new Redis(getRedisUrl());
}
