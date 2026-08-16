-- Atomic token-bucket increment for a single rate-limit key.
-- KEYS[1]  = Redis key (hash-tagged for cluster)
-- ARGV[1]  = bucket size (max tokens)
-- ARGV[2]  = refill rate (tokens per second)
-- ARGV[3]  = current timestamp in milliseconds
-- ARGV[4]  = key TTL in seconds (derived from bucketSize / refillRate)

local key = KEYS[1]
local bucketSize = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])

local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local lastRefillMs = tonumber(redis.call('HGET', key, 'lastRefillMs'))

if tokens == nil then
  tokens = bucketSize
  lastRefillMs = now
else
  local elapsedSeconds = math.max(0, now - lastRefillMs) / 1000
  tokens = math.min(bucketSize, tokens + (elapsedSeconds * refillRate))
  lastRefillMs = now
end

local allowed = 0
local totalHits = bucketSize + 1
local remaining = 0
local resetMs = math.ceil((1 / refillRate) * 1000)

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
  remaining = math.floor(tokens)
  totalHits = bucketSize - remaining
else
  local tokensNeeded = 1 - tokens
  resetMs = math.ceil((tokensNeeded / refillRate) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs)
redis.call('EXPIRE', key, ttlSeconds)

return { allowed, remaining, bucketSize, resetMs, totalHits }
