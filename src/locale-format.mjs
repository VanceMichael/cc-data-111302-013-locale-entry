// 本地化表示层：规则全部来自门户当前地区配置（GET /rules 的运行时数据），
// 不为某个页面硬编码字符串替换。新增地区只需让门户返回其规则。
import {toDecimal} from './money.mjs';
import {SemanticError} from './errors.mjs';

// 用语义金额和当前规则生成控件接受的文本。
// 若金额的小数位超出控件约束，由录入层在调用前判定，这里只做按位分组。
export function formatControlAmount(value, rules) {
  const decimal = toDecimal(value);
  const [integerPart, fractionPart = ''] = decimal.split('.');
  const sign = integerPart.startsWith('-') ? '-' : '';
  const digits = sign ? integerPart.slice(1) : integerPart;
  // 从右向左每三位插入分组符。
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, rules.group);
  const fraction = fractionPart ? `${rules.decimal}${fractionPart}` : '';
  return `${sign}${grouped}${fraction}`;
}

export function assertRulesShape(rules) {
  for (const key of ['decimal', 'group', 'currency', 'dateOrder', 'timeZone', 'region', 'revision']) {
    if (!(key in rules)) {
      throw new SemanticError(`门户规则缺少字段 ${key}`, 'bad-rules', {rules});
    }
  }
  if (!['YMD', 'MDY', 'DMY'].includes(rules.dateOrder)) {
    throw new SemanticError(`门户返回了未知日期顺序: ${rules.dateOrder}`, 'bad-rules', {rules});
  }
  return rules;
}
