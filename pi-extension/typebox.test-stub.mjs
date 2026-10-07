// CI-only TypeBox surface stub.
// Pi supplies the real "typebox" module at runtime. Lifecycle tests only need
// schema construction to succeed; they intentionally do not install a second
// host runtime module.
const scalar = (type) => (options = {}) => ({ type, ...options });

export const Type = {
  String: scalar("string"),
  Number: scalar("number"),
  Integer: scalar("integer"),
  Boolean: scalar("boolean"),
  Null: () => ({ type: "null" }),
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Union: (items, options = {}) => ({ anyOf: items, ...options }),
  Optional: (schema) => schema,
  Record: (key, value, options = {}) => ({ type: "object", key, value, ...options }),
};
