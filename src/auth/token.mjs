/**
 * 会话 token 的签发与验签
 *
 * 现在只有 WeAuto 一个使用方（各服务账号独立，见需求文档 §13），
 * 所以不再需要「跨服务共享 secret」那套约束。
 *
 * 约定：verify 失败一律返回 null，**不抛异常** —— 调用方（HTTP 中间件）
 * 只想判断「有效/无效」，让每个调用点写 try/catch 迟早会漏掉一处。
 */
import jwt from 'jsonwebtoken';

export const DEFAULT_TTL = process.env.JWT_EXPIRES || '7d';

export function sign(payload, secret, ttl = DEFAULT_TTL) {
  if (!secret) {
    // 配置缺失必须立刻炸掉，不能静默签出「用 undefined 当密钥」的 token
    throw new Error('签发 token 需要 jwtSecret，请检查 .env');
  }
  return jwt.sign(payload, secret, { expiresIn: ttl });
}

export function verify(token, secret) {
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(token, secret);
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch {
    return null;
  }
}

/** 从 `Authorization: Bearer xxx` 中取 token */
export function fromAuthHeader(header) {
  const raw = typeof header === 'string' ? header : '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : null;
}
