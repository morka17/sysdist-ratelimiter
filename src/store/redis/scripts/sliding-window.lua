-- Atomic sliding-window-log increment for a single rate-limit key.
-- KEYS[1]  = Redis key (hash-tagged for cluster)
-- ARGV[1]  = window length in seconds
-- ARGV[2]  = max points allowed in the window
-- ARGV[3]  = current timestamp in milliseconds
-- ARGV[4]  = unique member suffix (avoids ZADD collisions within the same ms)

local key = KEYS[1]
local windowSeconds = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local memberSuffix = ARGV[4]

local windowMs = windowSeconds * 1000
local windowStart = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
redis.call('ZADD', key, now, tostring(now) .. ':' .. memberSuffix)

local totalHits = redis.call('ZCARD', key)
redis.call('EXPIRE', key, windowSeconds)

local resetMs = windowMs
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] ~= nil then
  resetMs = math.max(0, tonumber(oldest[2]) + windowMs - now)
end

local remaining = math.max(0, limit - totalHits)
local allowed = totalHits <= limit and 1 or 0

return { allowed, remaining, limit, resetMs, totalHits }
