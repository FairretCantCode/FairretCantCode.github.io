#!/bin/sh
# Refresh raw KingshotPro data (CC-BY-4.0, attribute "KingshotPro (kingshotpro.com)").
# After refreshing, review js/heroes-data.js: op-code mapping of skills is hand-curated.
set -e
cd "$(dirname "$0")/.."
OUT=data/kingshotpro; TMP=$(mktemp -d)
for f in heroes gear charm; do curl -fsS -A rally-calc -o "$OUT/$f.json" "https://kingshotpro.com/data/$f.json"; done
for n in $(python3 -I -c "import json,re;print(' '.join(re.sub(r'[^a-z]+','-',h['name'].lower()) for h in json.load(open('$OUT/heroes.json'))['heroes']))"); do
  mkdir -p "$TMP/h"; curl -fsS -A rally-calc -o "$TMP/h/$n.html" "https://kingshotpro.com/heroes/$n/"
done
python3 -I scripts/scrape_hero_pages.py "$TMP/h" "$OUT/hero_pages.json" > /dev/null
echo "Updated $OUT"
