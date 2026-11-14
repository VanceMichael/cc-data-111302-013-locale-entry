// 语义录入层的错误类型。语义歧义不允许“选一个合理值继续”，
// 必须显式暴露给资料员并阻断暂存。
export class SemanticError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SemanticError';
    this.code = code;
    this.details = details;
  }
}

// 原值无法在控件约束下无损表达（小数位超限、币种不符、回读不一致）。
export class ConstraintMismatch extends SemanticError {
  constructor(message, details = {}) {
    super(message, 'constraint-mismatch', details);
    this.name = 'ConstraintMismatch';
  }
}

// 语义本身存在歧义（缺业务时区、偏移量缺失、日期文本无法唯一解析）。
export class AmbiguityError extends SemanticError {
  constructor(message, details = {}) {
    super(message, 'ambiguity', details);
    this.name = 'AmbiguityError';
  }
}

// 门户地区在暂存后被切换，revision 已失效，必须重新读取规则并重新录入。
export class RegionChangedError extends SemanticError {
  constructor(message, details = {}) {
    super(message, 'region-changed', details);
    this.name = 'RegionChangedError';
  }
}
