/**
 * 最小 ZIP 打包：只有一个文件、不加密、不写扩展字段。
 *
 * 【为什么需要它】
 *   Windows 用户下载 `.cmd` 时会被浏览器/安全软件/企业策略拦掉（提示「无法下载 -
 *   出现问题，请重试，或联系你的组织」）。压缩包不在这些策略的重点名单上，是绕过
 *   这类拦截最省事、也最不依赖用户操作习惯的做法。为一个 1KB 的批处理引一个 zip
 *   依赖不值当，所以这里手写 30 行。
 *
 * 【为什么是 deflate 而不是 store】
 *   Windows 资源管理器、7-Zip、macOS 归档工具都原生认 method=8；体积也小一半。
 *   用 node:zlib 的 deflateRawSync，不需要自己实现压缩。
 *
 * 只支持「一个文件」，因为这里唯一的用途就是一个启动器。多条目需要遍历中央目录，
 * 而调用方只有一处，YAGNI。
 */
import { deflateRawSync } from 'node:zlib';

/** CRC-32 查表，标准多项式 0xEDB88320 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** ZIP 每个条目都要带 CRC，否则解压端会报「数据损坏」 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS 时间格式：秒只有 2 秒精度（所以右移一位），年份从 1980 起算。
 * 解压工具会把它显示成「修改时间」，用当前时间比用 0（1980-00-00，非法）好。
 */
function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 把一个文件打成 zip。
 *
 * @param {string} name 包内文件名（不要带路径分隔符）
 * @param {string|Buffer} content
 * @param {{mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function zipSingleFile(name, content, { mtime = new Date() } = {}) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const body = deflateRawSync(data);
  const crc = crc32(data);
  const { time, date } = dosDateTime(mtime);

  // 本地文件头 30 字节 + 文件名
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 签名
  local.writeUInt16LE(20, 4); // 解压所需版本 2.0
  local.writeUInt16LE(0x0800, 6); // 通用标志：文件名是 UTF-8
  local.writeUInt16LE(8, 8); // 压缩方法 deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); // 压缩后
  local.writeUInt32LE(data.length, 22); // 压缩前
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // 扩展字段长度

  // 中央目录 46 字节 + 文件名
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // 制作版本（高字节 0 = MS-DOS，Windows 最友好）
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // 扩展字段
  central.writeUInt16LE(0, 32); // 注释
  central.writeUInt16LE(0, 34); // 起始磁盘号
  central.writeUInt16LE(0, 36); // 内部属性
  central.writeUInt32LE(0, 38); // 外部属性
  central.writeUInt32LE(0, 42); // 本地头偏移：唯一的条目必然从 0 开始

  const cdOffset = local.length + nameBuf.length + body.length;
  const cdSize = central.length + nameBuf.length;

  // 中央目录结尾
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录所在磁盘号
  eocd.writeUInt16LE(1, 8); // 本磁盘条目数
  eocd.writeUInt16LE(1, 10); // 总条目数
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}
