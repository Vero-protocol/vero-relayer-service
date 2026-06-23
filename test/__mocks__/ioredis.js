class MockRedis {
  constructor() {
    this.data = new Map();
    this.hashes = new Map();
    this.timers = new Map();
  }

  on() {
    // noop
  }

  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  async set(key, value, ...args) {
    this.data.set(key, String(value));
    const pxIndex = args.findIndex(a => a === 'PX');
    if (pxIndex !== -1) {
      const ttl = Number(args[pxIndex + 1]) || 0;
      if (ttl > 0) {
        if (this.timers.has(key)) clearTimeout(this.timers.get(key));
        const t = setTimeout(() => { this.data.delete(key); this.timers.delete(key); }, ttl);
        this.timers.set(key, t);
      }
    }
    return 'OK';
  }

  async hgetall(key) {
    const obj = this.hashes.get(key);
    return obj ? { ...obj } : {};
  }

  async hget(key, field) {
    const obj = this.hashes.get(key);
    return obj && Object.prototype.hasOwnProperty.call(obj, field) ? obj[field] : null;
  }

  async hset(key, field, value) {
    const obj = this.hashes.get(key) || {};
    obj[field] = value;
    this.hashes.set(key, obj);
    return 1;
  }

  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this.data.delete(k)) count++;
      if (this.hashes.delete(k)) count++;
    }
    return count;
  }

  async scan(cursor, ...args) {
    // simple implementation: no keys
    return ['0', []];
  }

  async quit() { return 'OK'; }
  disconnect() {}
}

module.exports = MockRedis;
