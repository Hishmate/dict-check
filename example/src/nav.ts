// t() references are scanned when `sources` is configured.
// "nav.home" resolves; "nav.search" does not exist in the dictionary.
export function Nav() {
  return [t("nav.home"), t("nav.search")];
}
