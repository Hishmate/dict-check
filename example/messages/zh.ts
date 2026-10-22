// A drifted locale, for demonstration:
//   - missing "intro.sub" and "greeting"
//   - an extra key "nav.blog" the base does not have
//   - a placeholder mismatch on "greeting" ({user} instead of {name})
const zh = {
  "nav.home": "首页",
  "nav.pricing": "价格",
  "nav.blog": "博客",
  "greeting": "你好 {user}",
};

export default zh;
