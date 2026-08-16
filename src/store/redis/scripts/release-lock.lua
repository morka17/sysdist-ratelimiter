-- Safe lock release: delete only when the stored token matches the caller's token.
-- KEYS[1] = lock key
-- ARGV[1] = token that must match the current value

if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end

return 0
