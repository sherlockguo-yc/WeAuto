/**
 * 密码哈希与校验
 *
 * 用 bcrypt（cost=12）而不是 Node 内置的 scrypt：本项目的密码只由管理员在 UI 里创建，
 * 数量以个位计，昂贵的参数反而是优点；bcryptjs 是纯 JS，没有原生编译问题。
 *
 * 安全要点：**用户不存在时也要消耗与真实校验相当的时间**，否则「用户不存在」会比
 * 「密码错误」返回得更快，可被用来枚举用户名。
 */
import bcrypt from 'bcryptjs';

export const BCRYPT_COST = 12;

/**
 * 用户不存在时使用的「陪跑」哈希。
 *
 * **必须是一个格式合法、cost 相同的真实哈希。** 手搓一个形似 bcrypt 的假字符串
 * 看似无害，实际 bcrypt 解析失败会立刻返回 false —— 耗时接近 0，于是
 * 「用户不存在」比「密码错误」快上百倍，正好刺穿这个函数本该修补的漏洞。
 * （这个坑真实存在过：tests/auth-password.test.mjs 的耗时断言抓到了它。）
 *
 * 代价是模块加载时多算一次哈希（cost=12 约 200ms，仅一次）。
 */
const DUMMY_HASH = bcrypt.hashSync('weauto-dummy-password-for-timing', BCRYPT_COST);

export function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_COST);
}

export function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch {
    // 哈希损坏不应让登录接口 500，按验证失败处理
    return false;
  }
}

/** 恒返回 false，只为消耗与真实校验相当的时间 */
export function burnTime(plain) {
  try {
    bcrypt.compareSync(String(plain), DUMMY_HASH);
  } catch {
    /* 忽略 */
  }
  return false;
}
