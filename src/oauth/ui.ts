/**
 * 授权相关页面共用的视觉层（登录页 `/authorize`、授权确认页等）。
 *
 * 左边品牌区（墨绿底 + 圆环纹样 + 标语），右边 Material 风格表单列。
 * 样式内联在单一常量中，避免额外的静态资源托管请求。
 */

/**
 * 品牌区底图与河流纹样（来自设计稿 Frame 10.svg）。
 * - 绿环层：墨绿背景 #034933 + 点阵 #08AB77（r=30，w=10）
 * - 蓝环层：河流曲线 #3B8FDE（r=37.5，w=25）
 *
 * 两层共用 1550×860 视口与 preserveAspectRatio="xMinYMax slice"，
 * 左侧边界切过 cx=0 圆心，形成完美的左侧半圆切边效果，整条河流严格相位对齐。
 * 圆环内部全部保持透明（fill: none）。
 */
const GREEN_LAYER_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1550 860' preserveAspectRatio='xMinYMax slice' fill='none'>` +
  `<style>circle{fill:none;}</style>` +
  `<rect width='1550' height='860' fill='#034933'/>` +
  `<g fill='none' stroke='#08AB77' stroke-width='10'><circle cx='50' cy='860' r='30'/><circle cx='150' cy='860' r='30'/><circle cx='350' cy='860' r='30'/><circle cx='450' cy='860' r='30'/><circle cx='550' cy='860' r='30'/><circle cx='650' cy='860' r='30'/><circle cx='750' cy='860' r='30'/><circle cx='0' cy='774' r='30'/><circle cx='100' cy='774' r='30'/><circle cx='200' cy='774' r='30'/><circle cx='500' cy='774' r='30'/><circle cx='400' cy='774' r='30'/><circle cx='600' cy='774' r='30'/><circle cx='700' cy='774' r='30'/><circle cx='50' cy='688' r='30'/><circle cx='150' cy='688' r='30'/><circle cx='450' cy='688' r='30'/><circle cx='550' cy='688' r='30'/><circle cx='650' cy='688' r='30'/><circle cx='750' cy='688' r='30'/><circle cx='0' cy='602' r='30'/><circle cx='100' cy='602' r='30'/><circle cx='200' cy='602' r='30'/><circle cx='300' cy='602' r='30'/><circle cx='550' cy='516' r='30'/><circle cx='650' cy='516' r='30'/><circle cx='200' cy='430' r='30'/><circle cx='300' cy='430' r='30'/><circle cx='600' cy='430' r='30'/><circle cx='150' cy='344' r='30'/><circle cx='250' cy='344' r='30'/><circle cx='350' cy='344' r='30'/><circle cx='450' cy='344' r='30'/><circle cx='750' cy='344' r='30'/><circle cx='100' cy='258' r='30'/><circle cx='200' cy='258' r='30'/><circle cx='300' cy='258' r='30'/><circle cx='400' cy='258' r='30'/><circle cx='500' cy='258' r='30'/><circle cx='600' cy='258' r='30'/><circle cx='700' cy='258' r='30'/><circle cx='50' cy='172' r='30'/><circle cx='150' cy='172' r='30'/><circle cx='250' cy='172' r='30'/><circle cx='350' cy='172' r='30'/><circle cx='450' cy='172' r='30'/><circle cx='550' cy='172' r='30'/><circle cx='650' cy='172' r='30'/><circle cx='750' cy='172' r='30'/><circle cx='0' cy='86' r='30'/><circle cx='100' cy='86' r='30'/><circle cx='200' cy='86' r='30'/><circle cx='300' cy='86' r='30'/><circle cx='400' cy='86' r='30'/><circle cx='500' cy='86' r='30'/><circle cx='600' cy='86' r='30'/><circle cx='700' cy='86' r='30'/><circle cx='800' cy='86' r='30'/><circle cx='800' cy='258' r='30'/><circle cx='800' cy='430' r='30'/><circle cx='800' cy='602' r='30'/><circle cx='800' cy='774' r='30'/><circle cx='50' cy='0' r='30'/><circle cx='150' cy='0' r='30'/><circle cx='250' cy='0' r='30'/><circle cx='350' cy='0' r='30'/><circle cx='450' cy='0' r='30'/><circle cx='550' cy='0' r='30'/><circle cx='650' cy='0' r='30'/><circle cx='750' cy='0' r='30'/><circle cx='400' cy='430' r='30'/><circle cx='1400' cy='86' r='30'/><circle cx='1500' cy='86' r='30'/><circle cx='1450' cy='0' r='30'/><circle cx='1550' cy='0' r='30'/><circle cx='1550' cy='860' r='30'/><circle cx='1300' cy='774' r='30'/><circle cx='1500' cy='774' r='30'/><circle cx='850' cy='172' r='30'/><circle cx='950' cy='172' r='30'/><circle cx='1050' cy='172' r='30'/><circle cx='1150' cy='172' r='30'/><circle cx='900' cy='86' r='30'/><circle cx='1000' cy='86' r='30'/><circle cx='1100' cy='86' r='30'/><circle cx='1200' cy='86' r='30'/><circle cx='1300' cy='86' r='30'/><circle cx='850' cy='0' r='30'/><circle cx='950' cy='0' r='30'/><circle cx='1050' cy='0' r='30'/><circle cx='1150' cy='0' r='30'/><circle cx='1250' cy='0' r='30'/><circle cx='1350' cy='0' r='30'/><circle cx='900' cy='258' r='30'/><circle cx='1000' cy='258' r='30'/><circle cx='1100' cy='258' r='30'/><circle cx='1200' cy='258' r='30'/><circle cx='1300' cy='258' r='30'/><circle cx='1400' cy='258' r='30'/><circle cx='1500' cy='258' r='30'/><circle cx='1350' cy='688' r='30'/><circle cx='1450' cy='688' r='30'/><circle cx='1350' cy='172' r='30'/><circle cx='1450' cy='172' r='30'/><circle cx='1550' cy='172' r='30'/><circle cx='950' cy='860' r='30'/><circle cx='1050' cy='860' r='30'/><circle cx='1150' cy='860' r='30'/><circle cx='1250' cy='860' r='30'/><circle cx='1250' cy='172' r='30'/><circle cx='850' cy='860' r='30'/><circle cx='1350' cy='860' r='30'/><circle cx='1450' cy='860' r='30'/><circle cx='900' cy='774' r='30'/><circle cx='1000' cy='774' r='30'/><circle cx='1100' cy='774' r='30'/><circle cx='1400' cy='774' r='30'/><circle cx='850' cy='688' r='30'/><circle cx='950' cy='688' r='30'/><circle cx='1050' cy='688' r='30'/><circle cx='1150' cy='688' r='30'/><circle cx='1250' cy='688' r='30'/><circle cx='1550' cy='688' r='30'/><circle cx='900' cy='602' r='30'/><circle cx='1000' cy='602' r='30'/><circle cx='1100' cy='602' r='30'/><circle cx='1200' cy='602' r='30'/><circle cx='1300' cy='602' r='30'/><circle cx='1400' cy='602' r='30'/><circle cx='1500' cy='602' r='30'/><circle cx='850' cy='516' r='30'/><circle cx='950' cy='516' r='30'/><circle cx='1050' cy='516' r='30'/><circle cx='1150' cy='516' r='30'/><circle cx='1250' cy='516' r='30'/><circle cx='1350' cy='516' r='30'/><circle cx='1450' cy='516' r='30'/><circle cx='1550' cy='516' r='30'/><circle cx='900' cy='430' r='30'/><circle cx='1000' cy='430' r='30'/><circle cx='1100' cy='430' r='30'/><circle cx='1200' cy='430' r='30'/><circle cx='1300' cy='430' r='30'/><circle cx='1400' cy='430' r='30'/><circle cx='1500' cy='430' r='30'/><circle cx='850' cy='344' r='30'/><circle cx='950' cy='344' r='30'/><circle cx='1050' cy='344' r='30'/><circle cx='1150' cy='344' r='30'/><circle cx='1250' cy='344' r='30'/><circle cx='1350' cy='344' r='30'/><circle cx='1450' cy='344' r='30'/><circle cx='1550' cy='344' r='30'/><circle cx='1200' cy='774' r='30'/><circle cx='250' cy='688' r='30'/><circle cx='0' cy='430' r='30'/><circle cx='50' cy='516' r='30'/></g></svg>`;

const RIVER_LAYER_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1550 860' preserveAspectRatio='xMinYMax slice' fill='none'>` +
  `<style>circle{fill:none;}</style>` +
  `<g fill='none' stroke='#3B8FDE' stroke-width='25'><circle cx='250' cy='860' r='37.5'/><circle cx='300' cy='774' r='37.5'/><circle cx='350' cy='688' r='37.5'/><circle cx='400' cy='602' r='37.5'/><circle cx='500' cy='602' r='37.5'/><circle cx='600' cy='602' r='37.5'/><circle cx='700' cy='602' r='37.5'/><circle cx='150' cy='516' r='37.5'/><circle cx='250' cy='516' r='37.5'/><circle cx='350' cy='516' r='37.5'/><circle cx='450' cy='516' r='37.5'/><circle cx='750' cy='516' r='37.5'/><circle cx='100' cy='430' r='37.5'/><circle cx='500' cy='430' r='37.5'/><circle cx='700' cy='430' r='37.5'/><circle cx='50' cy='344' r='37.5'/><circle cx='550' cy='344' r='37.5'/><circle cx='650' cy='344' r='37.5'/><circle cx='0' cy='258' r='37.5'/></g></svg>`;

/** 把 SVG 压成 CSS 里能直接用的 data URI（只转义必须转义的字符）。 */
function toDataUri(svg: string): string {
  const compact = svg.replace(/\n/g, '');
  return `url("data:image/svg+xml,${compact.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22')}")`;
}

const GREEN_LAYER = toDataUri(GREEN_LAYER_SVG);
const RIVER_LAYER = toDataUri(RIVER_LAYER_SVG);

/**
 * 品牌区文字矢量图形（来自设计稿「东湖事， 自在事。.svg」）。
 * 包含「东湖事，自在事。」标准字形与标点符号，采用 currentColor 配合 CSS 颜色控制（白色）。
 */
const SLOGAN_SVG = `<svg viewBox="0 0 265 173" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="东湖事，自在事。">` +
  `<title>东湖事，自在事。</title>` +
  `<g fill="currentColor"><path d="M250.8 144.88C253.253 144.88 255.44 145.467 257.36 146.64C259.28 147.813 260.827 149.387 262 151.36C263.173 153.28 263.76 155.44 263.76 157.84C263.76 160.187 263.173 162.347 262 164.32C260.827 166.293 259.28 167.867 257.36 169.04C255.44 170.213 253.253 170.8 250.8 170.8C248.453 170.8 246.293 170.213 244.32 169.04C242.347 167.867 240.773 166.293 239.6 164.32C238.48 162.347 237.92 160.187 237.92 157.84C237.92 155.44 238.48 153.28 239.6 151.36C240.773 149.387 242.347 147.813 244.32 146.64C246.293 145.467 248.453 144.88 250.8 144.88ZM250.88 165.04C252.853 165.04 254.533 164.347 255.92 162.96C257.307 161.52 258 159.813 258 157.84C258 156.507 257.68 155.307 257.04 154.24C256.4 153.12 255.52 152.24 254.4 151.6C253.333 150.96 252.16 150.64 250.88 150.64C249.547 150.64 248.347 150.96 247.28 151.6C246.213 152.24 245.333 153.12 244.64 154.24C244 155.307 243.68 156.507 243.68 157.84C243.68 159.173 244 160.4 244.64 161.52C245.333 162.587 246.213 163.44 247.28 164.08C248.347 164.72 249.547 165.04 250.88 165.04Z"/><path d="M190.16 96.72H199.92V162.72C199.92 165.067 199.6 166.827 198.96 168C198.32 169.173 197.227 170.107 195.68 170.8C194.134 171.387 192.214 171.76 189.92 171.92C187.68 172.08 184.854 172.16 181.44 172.16C181.227 171.04 180.8 169.733 180.16 168.24C179.52 166.8 178.88 165.573 178.24 164.56C179.574 164.613 180.907 164.667 182.24 164.72C183.574 164.72 184.774 164.72 185.84 164.72C186.96 164.72 187.734 164.72 188.16 164.72C188.907 164.667 189.414 164.507 189.68 164.24C190 163.973 190.16 163.467 190.16 162.72V96.72ZM160.24 102H230.64V109.52H160.24V102ZM177.6 118.88V122.64H212.88V118.88H177.6ZM168.4 112.8H222.72V128.72H168.4V112.8ZM166.48 132.32H224.08V163.6H214.32V138.8H166.48V132.32ZM158.4 142.24H232.48V149.52H158.4V142.24ZM165.84 153.2H219.6V160.16H165.84V153.2Z"/><path d="M79.7602 107.84H151.12V117.04H79.7602V107.84ZM105.84 133.76H147.84V142.64H105.84V133.76ZM102.8 160.96H150.88V169.84H102.8V160.96ZM122.16 120.48H131.84V165.68H122.16V120.48ZM105.04 96.72L115.04 99.12C113.067 105.52 110.587 111.84 107.6 118.08C104.614 124.32 101.014 130.133 96.8002 135.52C92.5869 140.907 87.6269 145.547 81.9202 149.44C81.6002 148.533 81.1469 147.52 80.5602 146.4C80.0269 145.28 79.4669 144.16 78.8802 143.04C78.2935 141.92 77.7335 140.987 77.2002 140.24C80.8269 137.893 84.1069 135.067 87.0402 131.76C90.0269 128.453 92.6669 124.853 94.9602 120.96C97.2535 117.067 99.2269 113.067 100.88 108.96C102.587 104.853 103.974 100.773 105.04 96.72ZM89.0402 130.24H98.7202V171.76H89.0402V130.24Z"/><path d="M13.3599 124.56H56.8799V133.44H13.3599V124.56ZM13.3599 141.68H56.8799V150.56H13.3599V141.68ZM13.3599 158.88H56.8799V167.76H13.3599V158.88ZM6.87988 107.12H64.9599V171.68H54.7999V116.32H16.5599V171.84H6.87988V107.12ZM29.5999 96.6399L41.1999 97.9199C40.2399 100.533 39.2266 103.093 38.1599 105.6C37.0932 108.107 36.1066 110.267 35.1999 112.08L26.3999 110.48C26.8266 109.147 27.2532 107.68 27.6799 106.08C28.1065 104.427 28.4799 102.8 28.7999 101.2C29.1732 99.5466 29.4399 98.0266 29.5999 96.6399Z"/><path d="M190.16 0.719971H199.92V66.72C199.92 69.0666 199.6 70.8266 198.96 72C198.32 73.1733 197.227 74.1066 195.68 74.8C194.134 75.3866 192.214 75.76 189.92 75.92C187.68 76.08 184.854 76.16 181.44 76.16C181.227 75.04 180.8 73.7333 180.16 72.24C179.52 70.8 178.88 69.5733 178.24 68.56C179.574 68.6133 180.907 68.6666 182.24 68.72C183.574 68.72 184.774 68.72 185.84 68.72C186.96 68.72 187.734 68.72 188.16 68.72C188.907 68.6666 189.414 68.5066 189.68 68.24C190 67.9733 190.16 67.4666 190.16 66.72V0.719971ZM160.24 5.99997H230.64V13.52H160.24V5.99997ZM177.6 22.88V26.64H212.88V22.88H177.6ZM168.4 16.8H222.72V32.72H168.4V16.8ZM166.48 36.32H224.08V67.6H214.32V42.8H166.48V36.32ZM158.4 46.24H232.48V53.52H158.4V46.24ZM165.84 57.2H219.6V64.16H165.84V57.2Z"/><path d="M106.241 3.27993H114.961V41.0399H106.241V3.27993ZM95.9207 16.3199H124.161V25.0399H95.9207V16.3199ZM130.561 3.43993H146.561V11.9199H130.561V3.43993ZM130.561 22.3999H146.881V30.7999H130.561V22.3999ZM130.561 41.4399H146.881V49.8399H130.561V41.4399ZM98.2407 37.2799H106.401V70.3999H98.2407V37.2799ZM102.481 37.2799H122.641V64.9599H102.481V56.6399H114.321V45.5199H102.481V37.2799ZM126.481 3.43993H134.881V35.6799C134.881 38.8266 134.747 42.2133 134.481 45.8399C134.267 49.4666 133.787 53.1199 133.041 56.7999C132.347 60.4266 131.334 63.9199 130.001 67.2799C128.667 70.5866 126.854 73.5466 124.561 76.1599C124.081 75.6799 123.387 75.1199 122.481 74.4799C121.627 73.8933 120.721 73.3066 119.761 72.7199C118.854 72.1333 118.081 71.6799 117.441 71.3599C119.521 68.9066 121.174 66.2133 122.401 63.2799C123.627 60.3466 124.534 57.3066 125.121 54.1599C125.707 51.0133 126.081 47.8666 126.241 44.7199C126.401 41.5199 126.481 38.5066 126.481 35.6799V3.43993ZM142.321 3.43993H150.881V65.9199C150.881 67.8399 150.641 69.3866 150.161 70.5599C149.734 71.7866 148.907 72.7466 147.681 73.4399C146.454 74.1866 144.961 74.6399 143.201 74.7999C141.494 75.0133 139.414 75.0933 136.961 75.0399C136.747 73.9733 136.374 72.6399 135.841 71.0399C135.307 69.4399 134.721 68.1333 134.081 67.1199C135.574 67.1733 136.961 67.2266 138.241 67.2799C139.574 67.2799 140.481 67.2799 140.961 67.2799C141.494 67.2266 141.841 67.0933 142.001 66.8799C142.214 66.6666 142.321 66.2933 142.321 65.7599V3.43993ZM80.8007 8.47993L86.0807 1.67993C87.5207 2.2666 89.0407 2.9866 90.6407 3.83993C92.294 4.69327 93.8407 5.57327 95.2807 6.47993C96.774 7.3866 97.974 8.2666 98.8807 9.11993L93.2807 16.6399C92.4273 15.7866 91.3073 14.8799 89.9207 13.9199C88.534 12.9066 87.014 11.9199 85.3607 10.9599C83.7607 9.9466 82.2407 9.11993 80.8007 8.47993ZM77.6807 29.7599L82.8807 22.8799C84.374 23.4666 85.9207 24.1599 87.5207 24.9599C89.174 25.7066 90.7207 26.5333 92.1607 27.4399C93.654 28.2933 94.854 29.1199 95.7607 29.9199L90.3207 37.5199C89.4673 36.6666 88.3207 35.7866 86.8807 34.8799C85.494 33.9199 83.974 32.9866 82.3207 32.0799C80.7207 31.1733 79.174 30.3999 77.6807 29.7599ZM78.8807 70.1599C79.9473 68.0266 81.0673 65.5733 82.2407 62.7999C83.4673 59.9733 84.694 56.9866 85.9207 53.8399C87.1473 50.6399 88.294 47.4666 89.3607 44.3199L97.0407 49.3599C96.134 52.1866 95.1473 55.0933 94.0807 58.0799C93.0673 61.0133 92.0007 63.9199 90.8807 66.7999C89.7607 69.6799 88.6673 72.4266 87.6007 75.0399L78.8807 70.1599Z"/><path d="M8.64 44.32V36.96L14.16 33.76H66.24L66.16 43.04H18C16.56 43.04 15.1733 43.0933 13.84 43.2C12.5067 43.3067 11.36 43.4667 10.4 43.68C9.49333 43.84 8.90667 44.0533 8.64 44.32ZM34.48 23.52H44.24V64.32C44.24 66.72 43.9467 68.64 43.36 70.08C42.7733 71.5733 41.6533 72.6933 40 73.44C38.4 74.24 36.4533 74.7467 34.16 74.96C31.92 75.1733 29.3333 75.28 26.4 75.28C26.2933 74.3733 26.0267 73.3067 25.6 72.08C25.2267 70.9067 24.8 69.7333 24.32 68.56C23.84 67.3867 23.36 66.3467 22.88 65.44C24.96 65.4933 26.9333 65.5467 28.8 65.6C30.72 65.6533 32.0267 65.6533 32.72 65.6C33.4133 65.6 33.8667 65.4933 34.08 65.28C34.3467 65.0667 34.48 64.6933 34.48 64.16V23.52ZM13.92 47.92L23.52 50.56C22.3467 53.44 20.9067 56.2933 19.2 59.12C17.4933 61.9467 15.68 64.5867 13.76 67.04C11.8933 69.44 10 71.5733 8.08 73.44C7.49333 72.9067 6.69333 72.24 5.68 71.44C4.72 70.64 3.73333 69.84 2.72 69.04C1.70667 68.2933 0.8 67.7067 0 67.28C2.88 64.9867 5.54667 62.1067 8 58.64C10.5067 55.12 12.48 51.5467 13.92 47.92ZM48.48 51.76L56.56 47.84C58.4267 49.8133 60.3733 52 62.4 54.4C64.4267 56.7467 66.2933 59.0667 68 61.36C69.76 63.6533 71.1733 65.7333 72.24 67.6L63.44 72.16C62.5333 70.2933 61.2533 68.1867 59.6 65.84C57.9467 63.44 56.1333 61.0133 54.16 58.56C52.24 56.1067 50.3467 53.84 48.48 51.76ZM1.04 10.96H69.92V20.16H1.04V10.96ZM8.64 44.32C8.42667 43.68 8.10667 42.7733 7.68 41.6C7.30667 40.3733 6.88 39.12 6.4 37.84C5.97333 36.56 5.54667 35.4667 5.12 34.56C6.29333 34.24 7.36 33.6 8.32 32.64C9.33333 31.6267 10.48 30.2933 11.76 28.64C12.5067 27.7867 13.4933 26.4267 14.72 24.56C16 22.64 17.3867 20.3733 18.88 17.76C20.4267 15.1467 21.9733 12.32 23.52 9.28C25.12 6.24 26.5333 3.14667 27.76 0L38.4 3.76C36.32 8.13333 34 12.4533 31.44 16.72C28.9333 20.9333 26.3733 24.9067 23.76 28.64C21.1467 32.3733 18.5867 35.76 16.08 38.8V39.04C16.08 39.04 15.68 39.2267 14.88 39.6C14.1333 39.9733 13.28 40.4533 12.32 41.04C11.36 41.5733 10.5067 42.1333 9.76 42.72C9.01333 43.3067 8.64 43.84 8.64 44.32Z"/><path d="M251.56 144.8C254.013 144.8 256.2 145.386 258.12 146.56C260.04 147.733 261.586 149.306 262.76 151.28C263.933 153.2 264.52 155.36 264.52 157.76C264.52 160.106 263.933 162.266 262.76 164.24C261.586 166.213 260.04 167.786 258.12 168.96C256.2 170.133 254.013 170.72 251.56 170.72C249.213 170.72 247.053 170.133 245.08 168.96C243.106 167.786 241.533 166.213 240.36 164.24C239.24 162.266 238.68 160.106 238.68 157.76C238.68 155.36 239.24 153.2 240.36 151.28C241.533 149.306 243.106 147.733 245.08 146.56C247.053 145.386 249.213 144.8 251.56 144.8ZM251.64 164.96C253.613 164.96 255.293 164.266 256.68 162.88C258.066 161.44 258.76 159.733 258.76 157.76C258.76 156.426 258.44 155.226 257.8 154.16C257.16 153.04 256.28 152.16 255.16 151.52C254.093 150.88 252.92 150.56 251.64 150.56C250.306 150.56 249.106 150.88 248.04 151.52C246.973 152.16 246.093 153.04 245.4 154.16C244.76 155.226 244.44 156.426 244.44 157.76C244.44 159.093 244.76 160.32 245.4 161.44C246.093 162.506 246.973 163.36 248.04 164C249.106 164.64 250.306 164.96 251.64 164.96Z"/><path d="M238.36 70.72L243.2 63.88C242.134 63.4 241.2 62.6 240.4 61.48C239.6 60.3333 239.2 58.9733 239.2 57.4C239.2 55.2133 239.934 53.3866 241.4 51.92C242.894 50.4533 244.787 49.72 247.08 49.72C249.347 49.72 251.214 50.4533 252.68 51.92C254.174 53.3866 254.92 55.2533 254.92 57.52C254.92 58.8533 254.654 60.12 254.12 61.32C253.587 62.4933 252.747 63.9066 251.6 65.56L244.88 75.24C244.88 75.24 242.707 73.7333 238.36 70.72Z"/></g></svg>`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 共用样式。
 *
 * 约定（两边都必须遵守，否则又会分叉）：
 *   - 表单列里的一切放在 `.form-col` 里
 *   - 输入框用 `.field` + `input` + `label`（标签压在边框上，Material outlined）
 *   - 主按钮放 `.actions` 里（右对齐、100×50 实心）；危险操作用 `.actions--danger`
 *   - 提示块用 `.error`（报错）/ `.notice`（说明）/ `.result`（操作结果）
 */
const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    color-scheme: light dark;
    /* 品牌区（取自设计稿） */
    --brand-bg: #034933;
    /* Material：主色取设计稿里的蓝，输入框沿用中性描边 */
    --accent: #2583da;
    --accent-strong: #1c6cba;
    --accent-soft: rgba(37, 131, 218, .32);
    --danger: #b3261e;
    --danger-strong: #8c1d18;
    --surface: #fff;
    --ink: #000;
    --outline: #949494;
    --muted: #6b6b6b;
    --tint: rgba(127, 127, 127, .09);
    --error-bg: #f9dedc;
    --error-ink: #8c1d18;
    --ok-bg: #d7f0dd;
    --ok-ink: #10562c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #141218;
      --ink: #e6e1e5;
      --outline: #8e8a93;
      --muted: #a9a4ae;
      --tint: rgba(230, 225, 229, .08);
      --accent-soft: rgba(120, 175, 240, .34);
      --danger: #f2b8b5;
      --danger-strong: #f9dedc;
      --error-bg: #8c1d18;
      --error-ink: #f9dedc;
      --ok-bg: #10562c;
      --ok-ink: #d7f0dd;
    }
  }

  body {
    margin: 0;
    background: var(--surface);
    color: var(--ink);
    font-family: system-ui, -apple-system, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei",
                 "Noto Sans SC", "Hiragino Sans GB", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .page { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; min-height: 100dvh; }

  /* ---- 左：品牌区 ---- */
  .brand { position: relative; overflow: hidden; background: var(--brand-bg); }

  /* 桌面端：左半屏钉在视口上，右半边滚动时不带动左侧品牌纹样 */
  @media (min-width: 881px) {
    .brand { position: fixed; inset: 0 auto 0 0; width: 50%; }
    .panel { grid-column: 2; }
  }
  .rings {
    position: absolute; inset: 0;
    background-image: ${GREEN_LAYER};
    background-size: cover;
    background-position: left bottom;
    background-repeat: no-repeat;
    pointer-events: none;
  }
  .rings--river {
    background-image: ${RIVER_LAYER};
    background-size: cover;
    background-position: left bottom;
    background-repeat: no-repeat;
    pointer-events: none;
  }
  .slogan {
    position: absolute;
    left: clamp(16px, calc(18 / 860 * 100vh), 32px);
    bottom: clamp(24px, calc(32 / 860 * 100vh), 56px);
    width: clamp(180px, calc(265 / 860 * 100vh), 380px);
    height: auto;
    color: #fff;
    pointer-events: none;
    z-index: 1;
    line-height: 0;
  }
  .slogan svg {
    display: block;
    width: 100%;
    height: auto;
  }

  /* ---- 右：表单列 ---- */
  /* 底部多留 18px：设计稿里这一列比几何中心略高一点点，按设计稿的位置来 */
  .panel { display: flex; flex-direction: column; justify-content: center; padding: 48px 34px 66px; }
  .form-col { width: 100%; max-width: 732px; margin: 0 auto; }

  .title {
    margin: 0; font-size: clamp(28px, 2.5vw, 40px); font-weight: 700;
    line-height: 1.2; letter-spacing: .02em;
    /* 窄屏会折行：让它均衡折成两行，而不是把最后一个字甩到第二行 */
    text-wrap: balance;
  }
  .lead { margin: 14px 0 0; font-size: 15px; line-height: 1.7; color: var(--muted); }

  /* 主表单与标题之间留白 */
  .form-col > form, .main > form { margin-top: 38px; }

  /* 外框式文本域：标签恒压在边框上（设计稿即如此） */
  .field { position: relative; }
  .field + .field, .field + .row, .row + .field { margin-top: 19px; }
  .row { display: flex; gap: 14px; }
  .row > .field { flex: 1; }
  .field input {
    width: 100%; height: 52px; padding: 0 16px;
    font: inherit; font-size: 16px; color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--outline); border-radius: 8px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .field input:hover { border-color: var(--ink); }
  .field input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .field label {
    position: absolute; top: 0; left: 10px; transform: translateY(-50%);
    padding: 0 5px; background: var(--surface); color: var(--outline);
    font-size: 15px; line-height: 1; pointer-events: none;
    transition: color .15s ease;
  }
  .field input:focus + label { color: var(--accent); }
  .field input:-webkit-autofill {
    -webkit-text-fill-color: var(--ink);
    -webkit-box-shadow: 0 0 0 60px var(--surface) inset;
  }
  .field .hint { margin: 8px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }

  .error, .result {
    display: flex; gap: 10px; align-items: flex-start;
    margin-top: 18px; padding: 12px 14px; border-radius: 8px;
    background: var(--error-bg); color: var(--error-ink);
    font-size: 14px; line-height: 1.5;
  }
  .error svg { flex: none; width: 20px; height: 20px; fill: currentColor; margin-top: 1px; }
  .result.ok { background: var(--ok-bg); color: var(--ok-ink); }

  /* 说明块：声明、注意事项 —— 用淡底容器，不要用一根细线糊过去 */
  .notice {
    margin-top: 26px; padding: 16px 18px; border-radius: 10px;
    background: var(--tint);
    font-size: 13px; line-height: 1.75; color: var(--muted);
  }
  .notice h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--ink); }
  .notice ul { margin: 0; padding-left: 18px; }
  .notice li + li { margin-top: 6px; }
  .notice p { margin: 0; }
  .notice p + p { margin-top: 8px; }
  .notice strong { color: var(--ink); font-weight: 600; }
  .notice a, .consent a { color: var(--accent); }

  /* 折叠式说明块：默认收起，标题行要写清是什么，展开/收起状态自己会变 */
  .accordion {
    margin-top: 26px; border-radius: 10px; background: var(--tint);
    font-size: 13px; line-height: 1.8; color: var(--muted);
  }
  .accordion > summary {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 18px; cursor: pointer; list-style: none;
    font-size: 14px; font-weight: 600; color: var(--ink);
  }
  .accordion > summary::-webkit-details-marker { display: none; }
  .accordion > summary:focus-visible {
    outline: 3px solid var(--accent-soft); outline-offset: -3px; border-radius: 10px;
  }
  .accordion .acc-hint {
    margin-left: auto; font-size: 13px; font-weight: 400; color: var(--muted);
  }
  .accordion .chev {
    display: inline-block; font-size: 11px; color: var(--muted);
    transition: transform .15s ease;
  }
  .accordion[open] .chev { transform: rotate(180deg); }
  .accordion .when-open { display: none; }
  .accordion[open] .when-open { display: inline; }
  .accordion[open] .when-closed { display: none; }
  .accordion .acc-body { padding: 0 18px 16px; }
  .accordion .acc-body form { margin-top: 4px; }
  .accordion ol { margin: 0; padding-left: 20px; }
  .accordion li + li { margin-top: 8px; }
  .accordion strong { color: var(--ink); font-weight: 600; }
  .accordion a { color: var(--accent); }

  /* 同意勾选：声明必须被显式接受，否则服务端会拒绝 */
  .consent {
    display: flex; gap: 10px; align-items: flex-start;
    margin-top: 22px; font-size: 14px; line-height: 1.6; color: var(--ink);
  }
  .consent input { flex: none; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); }

  /* 验证码挂载点：与输入框左对齐，留出高度避免加载时跳动 */
  .turnstile-slot { margin-top: 22px; display: flex; justify-content: flex-start; min-height: 65px; }

  /* 实心按钮：设计稿里右对齐、100×50 */
  .actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 40px; }
  .actions button {
    min-width: 100px; height: 50px; padding: 0 22px;
    font: inherit; font-size: 20px; font-weight: 500; letter-spacing: .01em;
    color: #fff; background: var(--accent);
    border: 0; border-radius: 6px; cursor: pointer;
    transition: background-color .15s ease, box-shadow .15s ease;
  }
  .actions button:hover { background: var(--accent-strong); box-shadow: 0 1px 3px rgba(0, 0, 0, .24); }
  .actions button:active { box-shadow: none; }
  .actions button:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
  .actions button.btn-secondary {
    background: transparent; color: var(--ink); border: 1px solid var(--outline);
  }
  .actions button.btn-secondary:hover {
    background: var(--tint); box-shadow: none;
  }
  .actions button:disabled,
  .actions button.is-submitting {
    background: #949494 !important;
    color: rgba(255, 255, 255, .85) !important;
    border-color: transparent !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    pointer-events: none !important;
  }
  .actions--danger button { background: var(--danger); }
  .actions--danger button:hover { background: var(--danger-strong); }
  .actions--danger button:focus-visible { outline: 3px solid var(--danger); outline-offset: 2px; }

  .actions--left { justify-content: flex-start; }

  .client-domain {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; font-size: 13px;
    word-break: break-all;
  }

  .consent-title {
    margin: 0; font-size: clamp(24px, 2.4vw, 32px); font-weight: 600;
    line-height: 1.3; color: var(--ink); text-align: left;
  }
  .consent-title strong { color: var(--accent); }

  .consent-lead {
    margin-top: 24px; font-size: 15px; font-weight: 500; color: var(--ink); text-align: left;
  }

  .scope-list {
    margin-top: 16px; display: flex; flex-direction: column; gap: 14px; text-align: left;
  }
  .scope-item {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 0; background: transparent;
    font-size: 14px; line-height: 1.5; color: var(--ink);
  }
  .scope-icon {
    flex: none; width: 20px; height: 20px; margin-top: 1px;
    color: var(--accent); stroke: currentColor;
  }

  .trust-card {
    margin-top: 28px; padding: 16px 18px; border-radius: 10px;
    border: none; background: var(--tint);
    text-align: left;
  }
  .trust-card h3 {
    margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--ink);
  }
  .trust-card p {
    margin: 0; font-size: 13px; line-height: 1.6; color: var(--muted);
  }
  .trust-card p + p { margin-top: 8px; }

  /* 表单内的小折叠：一行可点的标题，展开后露出额外字段 */
  .fold-inline { margin-top: 22px; }
  .fold-inline > summary {
    display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer; list-style: none; font-size: 14px; color: var(--accent);
  }
  .fold-inline > summary::-webkit-details-marker { display: none; }
  .fold-inline > summary:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-radius: 4px; }
  .fold-inline > summary::before { content: '▸'; font-size: 11px; }
  .fold-inline[open] > summary::before { content: '▾'; }
  .fold-inline .field { margin-top: 16px; }

  .back { margin-top: 30px; font-size: 14px; }
  .back a { color: var(--accent); }

  /* ---- 登录页：说明块不参与居中，也不做内部滚动 ----
     做法：居中只作用于 .main（标题→按钮这块），说明块绝对定位在它正下方。
     于是无论展开还是收起：
       - 表单块停在同一个位置（始终居中）
       - 说明往下长、把页面撑长，读者自己滚页面（不做内部滚动条）
     矮屏和手机上同理：说明会延伸到视口下方，滚动即可看到，不会盖住按钮。 */
  .panel--centered .main { position: relative; }
  .panel--centered .main > .accordion,
  .panel--centered .main > .below {
    position: absolute; top: calc(100% + 26px); left: 0; right: 0; margin: 0;
  }
  /* 挂在下面的多个块之间留白 */
  .below > * + * { margin-top: 12px; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }

  /* 窄屏：品牌区收成顶部一条，表单铺满 */
  @media (max-width: 880px) {
    .page { grid-template-columns: 1fr; grid-template-rows: 190px auto; }
    .slogan {
      left: 18px;
      bottom: 18px;
      width: clamp(110px, 32vw, 135px);
    }
    .panel { justify-content: flex-start; padding: 36px 22px 48px; }
    .actions { margin-top: 32px; }
    .actions button { width: 100%; }
    .row { flex-direction: column; gap: 0; }
    .row > .field + .field { margin-top: 19px; }
  }
`;

/** 左边那半屏：品牌区。两页共用。 */
const BRAND_PANEL = `  <div class="brand">
    <div class="rings" aria-hidden="true"></div>
    <div class="rings rings--river" aria-hidden="true"></div>
    <div class="slogan" role="img" aria-label="东湖事，自在事。">${SLOGAN_SVG}</div>
  </div>`;

export interface ShellOptions {
  /** 浏览器标签标题 */
  title: string;
  /** 右半屏 `.form-col` 里的内容 */
  body: string;
  /** 页面级额外样式（可选） */
  extraCss?: string;
  /**
   * 右半屏的修饰类。
   * 登录页与确认页用 `panel--centered` 保持内容垂直居中。
   */
  panelClass?: string;
}

/** 渲染一个完整页面：左品牌区 + 右表单列。 */
export function pageShell(options: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${BASE_CSS}${options.extraCss ?? ''}</style></head>
<body>
<main class="page">
${BRAND_PANEL}
  <div class="panel${options.panelClass === undefined ? '' : ` ${options.panelClass}`}">
    <div class="form-col">
${options.body}
    </div>
  </div>
</main>
<script>
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var btn = e.submitter || (form && form.querySelector ? form.querySelector('button[type="submit"]') : null);
    if (btn) {
      btn.classList.add('is-submitting');
      setTimeout(function() { btn.disabled = true; }, 0);
    }
  });
</script>
</body></html>`;
}

/** Turnstile 挂载点 + 脚本。siteKey 为空时什么都不渲染（服务端仍会 fail closed）。 */
export function turnstileWidget(siteKey: string): string {
  if (siteKey === '') return '';
  return `      <div class="turnstile-slot">
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="turnstile-spin-v2"></div>
      </div>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
}
