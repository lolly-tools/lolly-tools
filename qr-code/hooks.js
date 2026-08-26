/**
 * QR Code tool hooks.
 *
 * Uses the qrcode-svg library (MIT, papnkukn/qrcode-svg) inlined so the tool
 * is fully self-contained and works offline inside the sandboxed Function()
 * scope (no imports, no globals beyond standard ECMAScript built-ins).
 *
 * The library generates a complete SVG string which the template renders
 * directly via {{{svgContent}}} - no per-module Handlebars loop needed.
 */

// ─── qrcode-svg library (MIT) ────────────────────────────────────────────────
// Source: https://github.com/papnkukn/qrcode-svg
// Modifications: removed QRCode.prototype.save (uses require('fs')) and the
// CommonJS module.exports guard - both incompatible with the sandbox.

function QR8bitByte(data) {
  this.mode = QRMode.MODE_8BIT_BYTE;
  this.data = data;
  this.parsedData = [];
  for (var i = 0, l = this.data.length; i < l; i++) {
    var byteArray = [];
    var code = this.data.charCodeAt(i);
    if (code > 0x10000) {
      byteArray[0] = 0xF0 | ((code & 0x1C0000) >>> 18);
      byteArray[1] = 0x80 | ((code & 0x3F000) >>> 12);
      byteArray[2] = 0x80 | ((code & 0xFC0) >>> 6);
      byteArray[3] = 0x80 | (code & 0x3F);
    } else if (code > 0x800) {
      byteArray[0] = 0xE0 | ((code & 0xF000) >>> 12);
      byteArray[1] = 0x80 | ((code & 0xFC0) >>> 6);
      byteArray[2] = 0x80 | (code & 0x3F);
    } else if (code > 0x80) {
      byteArray[0] = 0xC0 | ((code & 0x7C0) >>> 6);
      byteArray[1] = 0x80 | (code & 0x3F);
    } else {
      byteArray[0] = code;
    }
    this.parsedData.push(byteArray);
  }
  this.parsedData = Array.prototype.concat.apply([], this.parsedData);
  if (this.parsedData.length != this.data.length) {
    this.parsedData.unshift(191);
    this.parsedData.unshift(187);
    this.parsedData.unshift(239);
  }
}
QR8bitByte.prototype = {
  getLength: function() { return this.parsedData.length; },
  write: function(buffer) {
    for (var i = 0, l = this.parsedData.length; i < l; i++) buffer.put(this.parsedData[i], 8);
  }
};

// QR alphanumeric mode (ISO/IEC 18004 8.4.3): a 45-char set stored as 2 chars
// per 11 bits - 5.5 bits/char against byte mode's 8. This is what makes an
// uppercase token (a packed `z=2…` share link, an ALL-CAPS URL) render as a
// visibly smaller code.
var ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function QRAlphaNum(data) {
  this.mode = QRMode.MODE_ALPHA_NUM;
  this.data = data;
}
QRAlphaNum.prototype = {
  getLength: function() { return this.data.length; },
  write: function(buffer) {
    var i = 0;
    for (; i + 1 < this.data.length; i += 2) {
      buffer.put(ALNUM_CHARS.indexOf(this.data[i]) * 45 + ALNUM_CHARS.indexOf(this.data[i + 1]), 11);
    }
    if (i < this.data.length) buffer.put(ALNUM_CHARS.indexOf(this.data[i]), 6);
  }
};

// Split content into byte/alphanumeric segments. Every mode switch costs a
// ~15-20 bit header, so only alphanumeric runs long enough to repay it get
// their own segment; a fully-alphanumeric string always wins as one segment.
// Multi-segment splitting is ASCII-only: QR8bitByte prepends a UTF-8 BOM to
// any segment holding non-ASCII, and mid-stream BOMs would corrupt the payload.
var ALNUM_RUN_MIN = 20;
var ALNUM_RUN_RE = /[0-9A-Z $%*+\-./:]{20,}/g;  // keep the {20,} in sync with ALNUM_RUN_MIN
var ALNUM_ONLY_RE = /^[0-9A-Z $%*+\-./:]+$/;

function _segments(content) {
  if (ALNUM_ONLY_RE.test(content)) return [new QRAlphaNum(content)];
  if (/[^\x00-\x7f]/.test(content)) return [new QR8bitByte(content)];
  var out = [];
  var last = 0;
  var m;
  ALNUM_RUN_RE.lastIndex = 0;
  while ((m = ALNUM_RUN_RE.exec(content))) {
    if (m.index > last) out.push(new QR8bitByte(content.slice(last, m.index)));
    out.push(new QRAlphaNum(m[0]));
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push(new QR8bitByte(content.slice(last)));
  return out;
}

// Exact per-segment bit cost at a given version, incl. the mode+length headers.
function _segmentBits(segments, typeNumber) {
  var bits = 0;
  for (var i = 0; i < segments.length; i++) {
    var n = segments[i].getLength();
    bits += 4 + QRUtil.getLengthInBits(segments[i].mode, typeNumber);
    bits += segments[i].mode === QRMode.MODE_ALPHA_NUM ? 11 * (n >> 1) + 6 * (n % 2) : 8 * n;
  }
  return bits;
}

// Smallest version whose data capacity holds the segments - but never above the
// byte-mode ceiling _getTypeNumber already chose, which stays the single
// "Content too long" gate. Alphanumeric segments only ever need FEWER bits than
// the all-byte encoding the ceiling was sized for, so this can only shrink the
// code, never grow it.
function _fitType(segments, ecl, ceiling) {
  for (var t = 1; t < ceiling; t++) {
    var blocks = QRRSBlock.getRSBlocks(t, ecl);
    var capacity = 0;
    for (var b = 0; b < blocks.length; b++) capacity += blocks[b].dataCount * 8;
    if (_segmentBits(segments, t) <= capacity) return t;
  }
  return ceiling;
}

function QRCodeModel(typeNumber, errorCorrectLevel) {
  this.typeNumber = typeNumber;
  this.errorCorrectLevel = errorCorrectLevel;
  this.modules = null;
  this.moduleCount = 0;
  this.dataCache = null;
  this.dataList = [];
}
QRCodeModel.prototype={addData:function(data){var newData=new QR8bitByte(data);this.dataList.push(newData);this.dataCache=null;},isDark:function(row,col){if(row<0||this.moduleCount<=row||col<0||this.moduleCount<=col){throw new Error(row+","+col);}return this.modules[row][col];},getModuleCount:function(){return this.moduleCount;},make:function(){this.makeImpl(false,this.getBestMaskPattern());},makeImpl:function(test,maskPattern){this.moduleCount=this.typeNumber*4+17;this.modules=new Array(this.moduleCount);for(var row=0;row<this.moduleCount;row++){this.modules[row]=new Array(this.moduleCount);for(var col=0;col<this.moduleCount;col++){this.modules[row][col]=null;}}this.setupPositionProbePattern(0,0);this.setupPositionProbePattern(this.moduleCount-7,0);this.setupPositionProbePattern(0,this.moduleCount-7);this.setupPositionAdjustPattern();this.setupTimingPattern();this.setupTypeInfo(test,maskPattern);if(this.typeNumber>=7){this.setupTypeNumber(test);}if(this.dataCache==null){this.dataCache=QRCodeModel.createData(this.typeNumber,this.errorCorrectLevel,this.dataList);}this.mapData(this.dataCache,maskPattern);},setupPositionProbePattern:function(row,col){for(var r=-1;r<=7;r++){if(row+r<=-1||this.moduleCount<=row+r)continue;for(var c=-1;c<=7;c++){if(col+c<=-1||this.moduleCount<=col+c)continue;if((0<=r&&r<=6&&(c==0||c==6))||(0<=c&&c<=6&&(r==0||r==6))||(2<=r&&r<=4&&2<=c&&c<=4)){this.modules[row+r][col+c]=true;}else{this.modules[row+r][col+c]=false;}}}},getBestMaskPattern:function(){var minLostPoint=0;var pattern=0;for(var i=0;i<8;i++){this.makeImpl(true,i);var lostPoint=QRUtil.getLostPoint(this);if(i==0||minLostPoint>lostPoint){minLostPoint=lostPoint;pattern=i;}}return pattern;},setupTimingPattern:function(){for(var r=8;r<this.moduleCount-8;r++){if(this.modules[r][6]!=null){continue;}this.modules[r][6]=(r%2==0);}for(var c=8;c<this.moduleCount-8;c++){if(this.modules[6][c]!=null){continue;}this.modules[6][c]=(c%2==0);}},setupPositionAdjustPattern:function(){var pos=QRUtil.getPatternPosition(this.typeNumber);for(var i=0;i<pos.length;i++){for(var j=0;j<pos.length;j++){var row=pos[i];var col=pos[j];if(this.modules[row][col]!=null){continue;}for(var r=-2;r<=2;r++){for(var c=-2;c<=2;c++){if(r==-2||r==2||c==-2||c==2||(r==0&&c==0)){this.modules[row+r][col+c]=true;}else{this.modules[row+r][col+c]=false;}}}}}},setupTypeNumber:function(test){var bits=QRUtil.getBCHTypeNumber(this.typeNumber);for(var i=0;i<18;i++){var mod=(!test&&((bits>>i)&1)==1);this.modules[Math.floor(i/3)][i%3+this.moduleCount-8-3]=mod;}for(var i=0;i<18;i++){var mod=(!test&&((bits>>i)&1)==1);this.modules[i%3+this.moduleCount-8-3][Math.floor(i/3)]=mod;}},setupTypeInfo:function(test,maskPattern){var data=(this.errorCorrectLevel<<3)|maskPattern;var bits=QRUtil.getBCHTypeInfo(data);for(var i=0;i<15;i++){var mod=(!test&&((bits>>i)&1)==1);if(i<6){this.modules[i][8]=mod;}else if(i<8){this.modules[i+1][8]=mod;}else{this.modules[this.moduleCount-15+i][8]=mod;}}for(var i=0;i<15;i++){var mod=(!test&&((bits>>i)&1)==1);if(i<8){this.modules[8][this.moduleCount-i-1]=mod;}else if(i<9){this.modules[8][15-i-1+1]=mod;}else{this.modules[8][15-i-1]=mod;}}this.modules[this.moduleCount-8][8]=(!test);},mapData:function(data,maskPattern){var inc=-1;var row=this.moduleCount-1;var bitIndex=7;var byteIndex=0;for(var col=this.moduleCount-1;col>0;col-=2){if(col==6)col--;while(true){for(var c=0;c<2;c++){if(this.modules[row][col-c]==null){var dark=false;if(byteIndex<data.length){dark=(((data[byteIndex]>>>bitIndex)&1)==1);}var mask=QRUtil.getMask(maskPattern,row,col-c);if(mask){dark=!dark;}this.modules[row][col-c]=dark;bitIndex--;if(bitIndex==-1){byteIndex++;bitIndex=7;}}}row+=inc;if(row<0||this.moduleCount<=row){row-=inc;inc=-inc;break;}}}}};
QRCodeModel.PAD0=0xEC;QRCodeModel.PAD1=0x11;
QRCodeModel.createData=function(typeNumber,errorCorrectLevel,dataList){var rsBlocks=QRRSBlock.getRSBlocks(typeNumber,errorCorrectLevel);var buffer=new QRBitBuffer();for(var i=0;i<dataList.length;i++){var data=dataList[i];buffer.put(data.mode,4);buffer.put(data.getLength(),QRUtil.getLengthInBits(data.mode,typeNumber));data.write(buffer);}var totalDataCount=0;for(var i=0;i<rsBlocks.length;i++){totalDataCount+=rsBlocks[i].dataCount;}if(buffer.getLengthInBits()>totalDataCount*8){throw new Error("code length overflow. ("+buffer.getLengthInBits()+">"+totalDataCount*8+")");}if(buffer.getLengthInBits()+4<=totalDataCount*8){buffer.put(0,4);}while(buffer.getLengthInBits()%8!=0){buffer.putBit(false);}while(true){if(buffer.getLengthInBits()>=totalDataCount*8){break;}buffer.put(QRCodeModel.PAD0,8);if(buffer.getLengthInBits()>=totalDataCount*8){break;}buffer.put(QRCodeModel.PAD1,8);}return QRCodeModel.createBytes(buffer,rsBlocks);};
QRCodeModel.createBytes=function(buffer,rsBlocks){var offset=0;var maxDcCount=0;var maxEcCount=0;var dcdata=new Array(rsBlocks.length);var ecdata=new Array(rsBlocks.length);for(var r=0;r<rsBlocks.length;r++){var dcCount=rsBlocks[r].dataCount;var ecCount=rsBlocks[r].totalCount-dcCount;maxDcCount=Math.max(maxDcCount,dcCount);maxEcCount=Math.max(maxEcCount,ecCount);dcdata[r]=new Array(dcCount);for(var i=0;i<dcdata[r].length;i++){dcdata[r][i]=0xff&buffer.buffer[i+offset];}offset+=dcCount;var rsPoly=QRUtil.getErrorCorrectPolynomial(ecCount);var rawPoly=new QRPolynomial(dcdata[r],rsPoly.getLength()-1);var modPoly=rawPoly.mod(rsPoly);ecdata[r]=new Array(rsPoly.getLength()-1);for(var i=0;i<ecdata[r].length;i++){var modIndex=i+modPoly.getLength()-ecdata[r].length;ecdata[r][i]=(modIndex>=0)?modPoly.get(modIndex):0;}}var totalCodeCount=0;for(var i=0;i<rsBlocks.length;i++){totalCodeCount+=rsBlocks[i].totalCount;}var data=new Array(totalCodeCount);var index=0;for(var i=0;i<maxDcCount;i++){for(var r=0;r<rsBlocks.length;r++){if(i<dcdata[r].length){data[index++]=dcdata[r][i];}}}for(var i=0;i<maxEcCount;i++){for(var r=0;r<rsBlocks.length;r++){if(i<ecdata[r].length){data[index++]=ecdata[r][i];}}}return data;};

var QRMode={MODE_NUMBER:1<<0,MODE_ALPHA_NUM:1<<1,MODE_8BIT_BYTE:1<<2,MODE_KANJI:1<<3};
var QRErrorCorrectLevel={L:1,M:0,Q:3,H:2};
var QRMaskPattern={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};
var QRUtil={PATTERN_POSITION_TABLE:[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],G15:(1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0),G18:(1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0),G15_MASK:(1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1),getBCHTypeInfo:function(data){var d=data<<10;while(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15)>=0){d^=(QRUtil.G15<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15)));}return((data<<10)|d)^QRUtil.G15_MASK;},getBCHTypeNumber:function(data){var d=data<<12;while(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18)>=0){d^=(QRUtil.G18<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18)));}return(data<<12)|d;},getBCHDigit:function(data){var digit=0;while(data!=0){digit++;data>>>=1;}return digit;},getPatternPosition:function(typeNumber){return QRUtil.PATTERN_POSITION_TABLE[typeNumber-1];},getMask:function(maskPattern,i,j){switch(maskPattern){case QRMaskPattern.PATTERN000:return(i+j)%2==0;case QRMaskPattern.PATTERN001:return i%2==0;case QRMaskPattern.PATTERN010:return j%3==0;case QRMaskPattern.PATTERN011:return(i+j)%3==0;case QRMaskPattern.PATTERN100:return(Math.floor(i/2)+Math.floor(j/3))%2==0;case QRMaskPattern.PATTERN101:return(i*j)%2+(i*j)%3==0;case QRMaskPattern.PATTERN110:return((i*j)%2+(i*j)%3)%2==0;case QRMaskPattern.PATTERN111:return((i*j)%3+(i+j)%2)%2==0;default:throw new Error("bad maskPattern:"+maskPattern);}},getErrorCorrectPolynomial:function(errorCorrectLength){var a=new QRPolynomial([1],0);for(var i=0;i<errorCorrectLength;i++){a=a.multiply(new QRPolynomial([1,QRMath.gexp(i)],0));}return a;},getLengthInBits:function(mode,type){if(1<=type&&type<10){switch(mode){case QRMode.MODE_NUMBER:return 10;case QRMode.MODE_ALPHA_NUM:return 9;case QRMode.MODE_8BIT_BYTE:return 8;case QRMode.MODE_KANJI:return 8;default:throw new Error("mode:"+mode);}}else if(type<27){switch(mode){case QRMode.MODE_NUMBER:return 12;case QRMode.MODE_ALPHA_NUM:return 11;case QRMode.MODE_8BIT_BYTE:return 16;case QRMode.MODE_KANJI:return 10;default:throw new Error("mode:"+mode);}}else if(type<41){switch(mode){case QRMode.MODE_NUMBER:return 14;case QRMode.MODE_ALPHA_NUM:return 13;case QRMode.MODE_8BIT_BYTE:return 16;case QRMode.MODE_KANJI:return 12;default:throw new Error("mode:"+mode);}}else{throw new Error("type:"+type);}},getLostPoint:function(qrCode){var moduleCount=qrCode.getModuleCount();var lostPoint=0;for(var row=0;row<moduleCount;row++){for(var col=0;col<moduleCount;col++){var sameCount=0;var dark=qrCode.isDark(row,col);for(var r=-1;r<=1;r++){if(row+r<0||moduleCount<=row+r){continue;}for(var c=-1;c<=1;c++){if(col+c<0||moduleCount<=col+c){continue;}if(r==0&&c==0){continue;}if(dark==qrCode.isDark(row+r,col+c)){sameCount++;}}}if(sameCount>5){lostPoint+=(3+sameCount-5);}}}for(var row=0;row<moduleCount-1;row++){for(var col=0;col<moduleCount-1;col++){var count=0;if(qrCode.isDark(row,col))count++;if(qrCode.isDark(row+1,col))count++;if(qrCode.isDark(row,col+1))count++;if(qrCode.isDark(row+1,col+1))count++;if(count==0||count==4){lostPoint+=3;}}}for(var row=0;row<moduleCount;row++){for(var col=0;col<moduleCount-6;col++){if(qrCode.isDark(row,col)&&!qrCode.isDark(row,col+1)&&qrCode.isDark(row,col+2)&&qrCode.isDark(row,col+3)&&qrCode.isDark(row,col+4)&&!qrCode.isDark(row,col+5)&&qrCode.isDark(row,col+6)){lostPoint+=40;}}}for(var col=0;col<moduleCount;col++){for(var row=0;row<moduleCount-6;row++){if(qrCode.isDark(row,col)&&!qrCode.isDark(row+1,col)&&qrCode.isDark(row+2,col)&&qrCode.isDark(row+3,col)&&qrCode.isDark(row+4,col)&&!qrCode.isDark(row+5,col)&&qrCode.isDark(row+6,col)){lostPoint+=40;}}}var darkCount=0;for(var col=0;col<moduleCount;col++){for(var row=0;row<moduleCount;row++){if(qrCode.isDark(row,col)){darkCount++;}}}var ratio=Math.abs(100*darkCount/moduleCount/moduleCount-50)/5;lostPoint+=ratio*10;return lostPoint;}};

var QRMath={glog:function(n){if(n<1){throw new Error("glog("+n+")");}return QRMath.LOG_TABLE[n];},gexp:function(n){while(n<0){n+=255;}while(n>=256){n-=255;}return QRMath.EXP_TABLE[n];},EXP_TABLE:new Array(256),LOG_TABLE:new Array(256)};
for(var i=0;i<8;i++){QRMath.EXP_TABLE[i]=1<<i;}
for(var i=8;i<256;i++){QRMath.EXP_TABLE[i]=QRMath.EXP_TABLE[i-4]^QRMath.EXP_TABLE[i-5]^QRMath.EXP_TABLE[i-6]^QRMath.EXP_TABLE[i-8];}
for(var i=0;i<255;i++){QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]]=i;}

function QRPolynomial(num,shift){if(num.length==undefined){throw new Error(num.length+"/"+shift);}var offset=0;while(offset<num.length&&num[offset]==0){offset++;}this.num=new Array(num.length-offset+shift);for(var i=0;i<num.length-offset;i++){this.num[i]=num[i+offset];}}
QRPolynomial.prototype={get:function(index){return this.num[index];},getLength:function(){return this.num.length;},multiply:function(e){var num=new Array(this.getLength()+e.getLength()-1);for(var i=0;i<this.getLength();i++){for(var j=0;j<e.getLength();j++){num[i+j]^=QRMath.gexp(QRMath.glog(this.get(i))+QRMath.glog(e.get(j)));}}return new QRPolynomial(num,0);},mod:function(e){if(this.getLength()-e.getLength()<0){return this;}var ratio=QRMath.glog(this.get(0))-QRMath.glog(e.get(0));var num=new Array(this.getLength());for(var i=0;i<this.getLength();i++){num[i]=this.get(i);}for(var i=0;i<e.getLength();i++){num[i]^=QRMath.gexp(QRMath.glog(e.get(i))+ratio);}return new QRPolynomial(num,0).mod(e);}};

function QRRSBlock(totalCount,dataCount){this.totalCount=totalCount;this.dataCount=dataCount;}
// RS_BLOCK_TABLE repaired 2026-08-24 (v2.3.0): the originally vendored copy had a
// 16-row duplication and a truncated v15-H row, so versions 15-H and 19..40 either
// refused content ("code length overflow") or laid out structurally invalid codes.
// This is the canonical table from kazuhikoarase/qrcode-generator@2.0.4 (MIT),
// verified against the spec's per-version codeword totals; rows for v1..v15-Q are
// byte-identical to what always shipped.
QRRSBlock.RS_BLOCK_TABLE=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]];
QRRSBlock.getRSBlocks=function(typeNumber,errorCorrectLevel){var rsBlock=QRRSBlock.getRsBlockTable(typeNumber,errorCorrectLevel);if(rsBlock==undefined){throw new Error("bad rs block @ typeNumber:"+typeNumber+"/errorCorrectLevel:"+errorCorrectLevel);}var length=rsBlock.length/3;var list=[];for(var i=0;i<length;i++){var count=rsBlock[i*3+0];var totalCount=rsBlock[i*3+1];var dataCount=rsBlock[i*3+2];for(var j=0;j<count;j++){list.push(new QRRSBlock(totalCount,dataCount));}}return list;};
QRRSBlock.getRsBlockTable=function(typeNumber,errorCorrectLevel){switch(errorCorrectLevel){case QRErrorCorrectLevel.L:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+0];case QRErrorCorrectLevel.M:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+1];case QRErrorCorrectLevel.Q:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+2];case QRErrorCorrectLevel.H:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+3];default:return undefined;}};

function QRBitBuffer(){this.buffer=[];this.length=0;}
QRBitBuffer.prototype={get:function(index){var bufIndex=Math.floor(index/8);return((this.buffer[bufIndex]>>>(7-index%8))&1)==1;},put:function(num,length){for(var i=0;i<length;i++){this.putBit(((num>>>(length-i-1))&1)==1);}},getLengthInBits:function(){return this.length;},putBit:function(bit){var bufIndex=Math.floor(this.length/8);if(this.buffer.length<=bufIndex){this.buffer.push(0);}if(bit){this.buffer[bufIndex]|=(0x80>>>(this.length%8));}this.length++;}};

var QRCodeLimitLength=[[17,14,11,7],[32,26,20,14],[53,42,32,24],[78,62,46,34],[106,84,60,44],[134,106,74,58],[154,122,86,64],[192,152,108,84],[230,180,130,98],[271,213,151,119],[321,251,177,137],[367,287,203,155],[425,331,241,177],[458,362,258,194],[520,412,292,220],[586,450,322,250],[644,504,364,280],[718,560,394,310],[792,624,442,338],[858,666,482,382],[929,711,509,403],[1003,779,565,439],[1091,857,611,461],[1171,911,661,511],[1273,997,715,535],[1367,1059,751,593],[1465,1125,805,625],[1528,1190,868,658],[1628,1264,908,698],[1732,1370,982,742],[1840,1452,1030,790],[1952,1538,1112,842],[2068,1628,1168,898],[2188,1722,1228,958],[2303,1809,1283,983],[2431,1911,1351,1051],[2563,1989,1423,1093],[2699,2099,1499,1139],[2809,2213,1579,1219],[2953,2331,1663,1273]];

function QRCode(options) {
  this.options = {
    padding: 4,
    width: 256,
    height: 256,
    typeNumber: 4,
    color: '#000000',
    background: '#ffffff',
    ecl: 'M',
  };
  if (typeof options === 'string') options = { content: options };
  if (options) { for (var i in options) this.options[i] = options[i]; }
  if (typeof this.options.content !== 'string') throw new Error("Expected 'content' as string!");
  if (this.options.content.length === 0) throw new Error("Expected 'content' to be non-empty!");
  if (!(this.options.padding >= 0)) throw new Error("Expected 'padding' value to be non-negative!");
  if (!(this.options.width > 0) || !(this.options.height > 0)) throw new Error("Expected 'width' or 'height' value to be higher than zero!");

  function _getErrorCorrectLevel(ecl) {
    switch (ecl) {
      case 'L': return QRErrorCorrectLevel.L;
      case 'M': return QRErrorCorrectLevel.M;
      case 'Q': return QRErrorCorrectLevel.Q;
      case 'H': return QRErrorCorrectLevel.H;
      default: throw new Error('Unknown error correction level: ' + ecl);
    }
  }
  function _getTypeNumber(content, ecl) {
    var length = _getUTF8Length(content);
    var type = 1, limit = 0;
    for (var i = 0, len = QRCodeLimitLength.length; i <= len; i++) {
      var table = QRCodeLimitLength[i];
      if (!table) throw new Error('Content too long: expected ' + limit + ' but got ' + length);
      switch (ecl) {
        case 'L': limit = table[0]; break;
        case 'M': limit = table[1]; break;
        case 'Q': limit = table[2]; break;
        case 'H': limit = table[3]; break;
        default: throw new Error('Unknown error correction level: ' + ecl);
      }
      if (length <= limit) break;
      type++;
    }
    if (type > QRCodeLimitLength.length) throw new Error('Content too long');
    return type;
  }
  function _getUTF8Length(content) {
    var result = encodeURI(content).toString().replace(/%[0-9a-fA-F]{2}/g, 'a');
    return result.length + (result.length != content.length ? 3 : 0);
  }
  var content = this.options.content;
  // The byte-mode table stays the sizing ceiling and the "too long" gate; the
  // segmenter can only shrink the version from there (alphanumeric runs need
  // fewer bits than the all-byte encoding the ceiling assumed).
  var ceiling = _getTypeNumber(content, this.options.ecl);
  var ecl = _getErrorCorrectLevel(this.options.ecl);
  var segments = _segments(content);
  this.qrcode = new QRCodeModel(_fitType(segments, ecl, ceiling), ecl);
  for (var s = 0; s < segments.length; s++) this.qrcode.dataList.push(segments[s]);
  this.qrcode.make();
}

QRCode.prototype.svg = function(opt) {
  var options = this.options || {};
  var modules = this.qrcode.modules;
  if (typeof opt == 'undefined') opt = { container: options.container || 'svg' };

  var pretty = typeof options.pretty != 'undefined' ? !!options.pretty : true;
  var indent = pretty ? '  ' : '';
  var EOL = pretty ? '\r\n' : '';
  var width = options.width;
  var height = options.height;
  var length = modules.length;
  var xsize = width / (length + 2 * options.padding);
  var ysize = height / (length + 2 * options.padding);
  var join = typeof options.join != 'undefined' ? !!options.join : false;
  var swap = typeof options.swap != 'undefined' ? !!options.swap : false;
  var predefined = typeof options.predefined != 'undefined' ? !!options.predefined : false;
  var defs = predefined ? indent + '<defs><path id="qrmodule" d="M0 0 h' + ysize + ' v' + xsize + ' H0 z" style="fill:' + options.color + ';shape-rendering:crispEdges;" /></defs>' + EOL : '';
  var bgrect = indent + '<rect x="0" y="0" width="' + width + '" height="' + height + '" style="fill:' + options.background + ';shape-rendering:crispEdges;"/>' + EOL;
  var modrect = '';
  var pathdata = '';

  for (var y = 0; y < length; y++) {
    for (var x = 0; x < length; x++) {
      var module = modules[x][y];
      if (module) {
        var px = (x * xsize + options.padding * xsize);
        var py = (y * ysize + options.padding * ysize);
        if (swap) { var t = px; px = py; py = t; }
        if (join) {
          var w = xsize + px, h = ysize + py;
          px = (Number.isInteger(px)) ? Number(px) : px.toFixed(2);
          py = (Number.isInteger(py)) ? Number(py) : py.toFixed(2);
          w  = (Number.isInteger(w))  ? Number(w)  : w.toFixed(2);
          h  = (Number.isInteger(h))  ? Number(h)  : h.toFixed(2);
          pathdata += ('M' + px + ',' + py + ' V' + h + ' H' + w + ' V' + py + ' H' + px + ' Z ');
        } else if (predefined) {
          modrect += indent + '<use x="' + px.toString() + '" y="' + py.toString() + '" href="#qrmodule" />' + EOL;
        } else {
          modrect += indent + '<rect x="' + px.toString() + '" y="' + py.toString() + '" width="' + xsize + '" height="' + ysize + '" style="fill:' + options.color + ';shape-rendering:crispEdges;"/>' + EOL;
        }
      }
    }
  }
  if (join) {
    modrect = indent + '<path x="0" y="0" style="fill:' + options.color + ';shape-rendering:crispEdges;" d="' + pathdata + '" />';
  }

  var svg = '';
  switch (opt.container) {
    case 'svg':
      svg += '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + width + '" height="' + height + '">' + EOL;
      svg += defs + bgrect + modrect + '</svg>';
      break;
    case 'svg-viewbox':
      svg += '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" viewBox="0 0 ' + width + ' ' + height + '">' + EOL;
      svg += defs + bgrect + modrect + '</svg>';
      break;
    case 'g':
      svg += '<g width="' + width + '" height="' + height + '">' + EOL;
      svg += defs + bgrect + modrect + '</g>';
      break;
    default:
      svg += (defs + bgrect + modrect).replace(/^\s+/, '');
      break;
  }
  return svg;
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

// Module-level flag so beforeExport can read the last known transparent state.
var _transparentBg = false;

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A visible placeholder when the content can't be encoded (e.g. "Content too
// long"). Without this the throw propagates out of compute(), onInput swallows
// it, and the QR silently blanks with no explanation.
function _errorSvg(note) {
  return '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" viewBox="0 0 600 600">'
    + '<rect x="0" y="0" width="600" height="600" fill="#fff5f5"/>'
    + '<text x="300" y="286" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="#bd3314">QR code unavailable</text>'
    + '<text x="300" y="326" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#111111">' + _esc(note) + '</text>'
    + '</svg>';
}

// ─── Payload builders ────────────────────────────────────────────────────────
// One string per payload kind, in the wire format scanning apps expect. The
// escaping mirrors the engine's own template helpers (rfcText / icsStamp in
// engine/src/template.ts) so a vCard encoded here and a downloaded .vcf agree.
// An empty return means "nothing to encode yet" and the caller shows a hint.

var _KINDS = ['url', 'text', 'vcard', 'wifi', 'event', 'geo'];
var CRLF = '\r\n';

function _str(v) {
  return v == null ? '' : String(v).trim();
}

// RFC 5545 / RFC 6350 text escaping: backslash, semicolon, comma, newline.
function _rfc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// "2026-09-15T14:30" -> "20260915T143000", "2026-09-15" -> "20260915", "" -> "".
// Local time, no trailing Z: the event happens where the poster is.
function _icsStamp(v) {
  var s = _str(v);
  if (!s) return '';
  var parts = s.replace(/[-:]/g, '').split('T');
  if (parts.length < 2) return parts[0];
  return parts[0] + 'T' + (parts[1] + '0000').slice(0, 6);
}

// Join only the lines that have content, so an unfilled field leaves no record.
function _lines(list) {
  return list.filter(function(l) { return l; }).join(CRLF);
}

function _vcard(args) {
  var first = _str(args.firstname);
  var last = _str(args.lastname);
  var full = (first + ' ' + last).trim();
  // vCard 3.0 makes N and FN mandatory, so a nameless card is not a card -
  // the caller shows the hint instead.
  if (!full) return '';
  // N's five components are separated by literal semicolons, so each component
  // is escaped on its own before they are joined.
  var body = _lines([
    'N:' + _rfc(last) + ';' + _rfc(first) + ';;;',
    'FN:' + _rfc(full),
    _str(args.company) ? 'ORG:' + _rfc(_str(args.company)) : '',
    _str(args.jobTitle) ? 'TITLE:' + _rfc(_str(args.jobTitle)) : '',
    _str(args.phone) ? 'TEL;TYPE=CELL:' + _rfc(_str(args.phone)) : '',
    _str(args.email) ? 'EMAIL:' + _rfc(_str(args.email)) : '',
    _str(args.url) ? 'URL:' + _rfc(_str(args.url)) : '',
  ]);
  return _lines(['BEGIN:VCARD', 'VERSION:3.0', body, 'END:VCARD']);
}

// The WIFI: URI scheme escapes backslash, semicolon, comma, double quote and
// colon inside a value, since ';' and ':' are its own separators.
function _wifiEsc(v) {
  return String(v == null ? '' : v).replace(/([\\;,":])/g, '\\$1');
}

function _wifi(args) {
  var ssid = _str(args.ssid);
  if (!ssid) return '';
  var sec = (args.wifiSecurity === 'WEP' || args.wifiSecurity === 'nopass') ? args.wifiSecurity : 'WPA';
  var key = _str(args.wifiKey);
  var parts = ['T:' + sec, 'S:' + _wifiEsc(ssid)];
  // An open network has no password field at all, and neither does a secured
  // one the user has not typed a key into yet.
  if (sec !== 'nopass' && key) parts.push('P:' + _wifiEsc(key));
  if (args.wifiHidden === true || args.wifiHidden === 'true') parts.push('H:true');
  return 'WIFI:' + parts.join(';') + ';;';
}

function _event(args) {
  var name = _str(args.eventName);
  var start = _icsStamp(args.eventStart);
  // RFC 5545 makes DTSTART mandatory in a VEVENT and PRODID mandatory in the
  // VCALENDAR around it. An event missing either is one a calendar is entitled
  // to reject, so a missing start shows the hint instead of a code that only
  // fails once someone has printed it. UID/DTSTAMP are deliberately left out:
  // both need a clock, and a payload that changes between renders would break
  // the memo, the byte-pinned tests, and any reprint of the same poster.
  if (!name || !start) return '';
  return _lines([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lolly//QR//EN',
    'BEGIN:VEVENT',
    'SUMMARY:' + _rfc(name),
    'DTSTART:' + start,
    _icsStamp(args.eventEnd) ? 'DTEND:' + _icsStamp(args.eventEnd) : '',
    _str(args.eventLocation) ? 'LOCATION:' + _rfc(_str(args.eventLocation)) : '',
    _str(args.eventDetails) ? 'DESCRIPTION:' + _rfc(_str(args.eventDetails)) : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

// A coordinate that is not a real in-range number gets no code at all: falling
// back to 0 would encode a scannable pin off the coast of Africa, with nothing
// on the code to say it is not the place the user typed.
function _geo(args) {
  var lat = Number(args.lat);
  var lng = Number(args.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return '';
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return '';
  return 'geo:' + lat + ',' + lng;
}

function _payloadFor(args, kind) {
  if (kind === 'text') return _str(args.text);
  if (kind === 'vcard') return _vcard(args);
  if (kind === 'wifi') return _wifi(args);
  if (kind === 'event') return _event(args);
  if (kind === 'geo') return _geo(args);
  // 'url' - a neutral placeholder on blank input so a first render always shows a
  // valid QR (brand-agnostic community tool: no brand-specific default here).
  return (typeof args.url === 'string' && args.url.trim()) ? args.url.trim() : 'https://example.com';
}

var _KIND_HINT = {
  text: 'Add the text this QR code should carry.',
  vcard: 'Add a name to build a contact card.',
  wifi: 'Add the network name to build a Wi-Fi code.',
  event: 'Add an event name and a start time to build a calendar code.',
  geo: 'Add a latitude from -90 to 90 and a longitude from -180 to 180.',
};

// The manifest's a11yLabel reads "QR code holding {{default qrSummary ...}}",
// and Handlebars' `default` helper only fires on null/undefined - an empty
// string would leave a screen reader with "QR code holding". So every failure
// path carries its own words.
var _NO_SUMMARY = 'nothing yet';

function _fail(note, kind, content) {
  return {
    svgContent: _errorSvg(note),
    qrError: note,
    qrPayload: content || '',
    qrKind: kind,
    qrSummary: _NO_SUMMARY,
  };
}

// A short human line for the accessible label. The payload itself can be a
// whole multi-line vCard, which no one wants read out.
function _summary(args, kind, content) {
  if (kind === 'vcard') {
    var full = (_str(args.firstname) + ' ' + _str(args.lastname)).trim();
    return full ? 'a contact card for ' + full : 'a contact card';
  }
  if (kind === 'wifi') return 'Wi-Fi network ' + _str(args.ssid);
  if (kind === 'event') return 'calendar event ' + _str(args.eventName);
  if (kind === 'geo') return 'map location ' + content.slice(4);
  if (kind === 'text') return content.length > 60 ? content.slice(0, 60) + '...' : content;
  return content;
}

// One-entry memo: building the matrix + 8-pass mask search is O(n²)×8 per call,
// so cache the last result keyed on the input JSON. An unchanged input (e.g. a
// re-render that didn't touch any field) returns the cached SVG without rebuilding.
var _memoKey = null;
var _memoResult = null;

function compute(args) {
  var transparentBg = args.transparentBg;
  _transparentBg = Boolean(transparentBg);

  // The key is the whole args object, so every payload input is covered by
  // construction - there is no per-input list to keep in sync.
  var key = JSON.stringify(args);
  if (key === _memoKey) return _memoResult;

  var kind = _KINDS.indexOf(args.payload) >= 0 ? args.payload : 'url';
  var content = _payloadFor(args, kind);

  var result;
  if (!content) {
    // Nothing to encode for this kind yet. Same visible placeholder as an
    // encoder failure, with a hint about the field that is still empty.
    var hint = _KIND_HINT[kind] || 'Add some content for the QR code.';
    result = _fail(hint, kind, '');
  } else {
    try {
      var qr = new QRCode({
        content:    content,
        color:      args.color || '#111111',
        background: _transparentBg ? 'none' : (args.background || '#ffffff'),
        ecl:        args.ecl || 'M',
        padding:    Number.isFinite(Number(args.padding)) ? Math.max(0, Math.round(Number(args.padding))) : 4,
        join:       Boolean(args.join),
        width:      600,
        height:     600,
        pretty:     false,
      });
      result = {
        svgContent: qr.svg({ container: 'svg-viewbox' }),
        qrError: '',
        qrPayload: content,
        qrKind: kind,
        qrSummary: _summary(args, kind, content),
      };
    } catch (err) {
      var msg = (err && err.message) ? err.message : 'Could not generate QR code';
      var note = /too long|overflow/i.test(msg)
        ? 'Content is too long for a QR code - shorten the text or URL, or lower the error-correction level.'
        : msg;
      // qrError is surfaced to the template/UI; svgContent renders the note in-place.
      result = _fail(note, kind, content);
    }
  }

  _memoKey = key;
  _memoResult = result;
  return _memoResult;
}

// ─── Linear barcodes (folded from community/barcode, plans/147 T7a) ──────────
// EAN-13 / EAN-8 / UPC-A / Code 128 encoders, wrapped in an IIFE so their private
// helpers (_fail/_summary/_hex/_num/_esc/compute/…) do not collide with the QR
// builder above, which has same-named functions. Exposes one entry, computeBarcode,
// which takes the same args object the QR path builds and returns the SAME extras the
// template renders (svgContent + bc*). Reference-vector tested via qr-code payloads.
var BARCODE_KINDS = ["ean13", "ean8", "upca", "code128"];
var computeBarcode = (function () {
// ─── EAN / UPC tables ────────────────────────────────────────────────────────

// Odd-parity left-hand digit patterns (EAN/UPC set A), seven modules each.
var L_CODES = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

function _flip(pattern) {
  var out = '';
  for (var i = 0; i < pattern.length; i++) out += pattern.charAt(i) === '0' ? '1' : '0';
  return out;
}

function _reverse(pattern) {
  return pattern.split('').reverse().join('');
}

// Right-hand (set C) is the complement of set A; even-parity left (set B) is
// the right-hand pattern read backwards.
var R_CODES = L_CODES.map(_flip);
var G_CODES = R_CODES.map(_reverse);

// Which of the six left-hand digits use set B, keyed by the first digit. Only
// EAN-13 carries this: UPC-A is an EAN-13 whose first digit is 0, so it always
// takes the all-A row.
var PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

var GUARD_EDGE = '101';
var GUARD_MID = '01010';

// Modulo-10, weights 3 and 1 alternating from the RIGHTMOST body digit. One
// function covers EAN-13, EAN-8 and UPC-A because the alternation is anchored
// at the right, not at the left.
function eanCheckDigit(body) {
  var sum = 0;
  for (var i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(body.charAt(i)) * w;
  }
  return (10 - (sum % 10)) % 10;
}

// ─── Code 128 table ──────────────────────────────────────────────────────────

// Element widths, bar first, alternating. Values 0-105 are six elements summing
// to eleven modules; 106 is the stop pattern's seven elements summing to
// thirteen. Every row's bar widths sum to an even number, which is the
// symbology's own self-check and is asserted by tests/barcode.test.ts.
var C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

var C128_CODE_C = 99;
var C128_CODE_B = 100;
var C128_START_B = 104;
var C128_START_C = 105;
var C128_STOP = 106;

function _widthsToModules(widths) {
  var out = '';
  var dark = true;
  for (var i = 0; i < widths.length; i++) {
    var n = Number(widths.charAt(i));
    for (var k = 0; k < n; k++) out += dark ? '1' : '0';
    dark = !dark;
  }
  return out;
}

function _digitRun(text, from) {
  var n = 0;
  while (from + n < text.length) {
    var c = text.charCodeAt(from + n);
    if (c < 48 || c > 57) break;
    n++;
  }
  return n;
}

// Code sets B and C only. Set A buys control characters nobody puts on a label
// and costs a second shift rule, so it is deliberately not implemented: the
// validator refuses anything outside printable ASCII before we get here.
function encodeCode128(text) {
  var values = [];
  var mode = '';
  var i = 0;
  while (i < text.length) {
    var run = _digitRun(text, i);
    var even = run - (run % 2);
    // Four digits pay for the switch symbol plus the switch back; once inside
    // code set C a further pair is free, so two is enough to stay.
    var wantC = mode === 'C' ? run >= 2 : even >= 4;
    if (wantC) {
      if (mode !== 'C') {
        values.push(mode === '' ? C128_START_C : C128_CODE_C);
        mode = 'C';
      }
      for (var k = 0; k + 1 < run; k += 2) {
        values.push(Number(text.charAt(i + k) + text.charAt(i + k + 1)));
      }
      i += even;
      continue;
    }
    if (mode !== 'B') {
      values.push(mode === '' ? C128_START_B : C128_CODE_B);
      mode = 'B';
    }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }
  // Modulo 103 over the start symbol (weight 1) and each data symbol weighted
  // by its one-based position.
  var sum = values[0];
  for (var p = 1; p < values.length; p++) sum += values[p] * p;
  var check = sum % 103;
  var all = values.concat([check, C128_STOP]);
  var modules = '';
  for (var m = 0; m < all.length; m++) modules += _widthsToModules(C128[all[m]]);
  return {
    modules: modules,
    symbols: all,
    check: check,
    // No guard bars to make room for, so the text sits under the field.
    descend: [],
    labels: [{ x: modules.length / 2, anchor: 'middle', str: text }],
    textStyle: 'below',
  };
}

// ─── Symbology encoders ──────────────────────────────────────────────────────
//
// Each returns { modules, descend, labels, textStyle }. `descend` lists the
// module ranges whose bars run past the bottom of the field (the guards);
// `labels` places the human-readable digits in module coordinates, where module
// 0 is the first module of the symbol and a negative x sits in the quiet zone.

function _leftHalf(digits, parityRow) {
  var out = '';
  for (var i = 0; i < 6; i++) {
    var d = Number(digits.charAt(i));
    out += parityRow.charAt(i) === 'L' ? L_CODES[d] : G_CODES[d];
  }
  return out;
}

function _rightHalf(digits) {
  var out = '';
  for (var i = 0; i < digits.length; i++) out += R_CODES[Number(digits.charAt(i))];
  return out;
}

// One printed digit centred under each seven-module cell, starting at module
// `from`.
function _cells(from, digits) {
  var out = [];
  for (var i = 0; i < digits.length; i++) {
    out.push({ x: from + i * 7 + 3.5, anchor: 'middle', str: digits.charAt(i) });
  }
  return out;
}

function encodeEan13(value) {
  var modules = GUARD_EDGE + _leftHalf(value.slice(1, 7), PARITY[Number(value.charAt(0))])
    + GUARD_MID + _rightHalf(value.slice(7)) + GUARD_EDGE;
  var labels = [{ x: -1.5, anchor: 'end', str: value.charAt(0) }]
    .concat(_cells(3, value.slice(1, 7)), _cells(50, value.slice(7)));
  return { modules: modules, descend: [[0, 3], [45, 50], [92, 95]], labels: labels, textStyle: 'inline' };
}

// UPC-A is an EAN-13 with a leading zero. Only the printed digits differ: the
// number-system digit and the check digit sit outside the guards.
function encodeUpca(value) {
  var wide = '0' + value;
  var enc = encodeEan13(wide);
  // The number-system digit owns the first left-hand cell and the check digit
  // the last right-hand one, but both are printed outside the guards.
  var labels = [{ x: -1.5, anchor: 'end', str: value.charAt(0) }]
    .concat(_cells(10, value.slice(1, 6)), _cells(50, value.slice(6, 11)));
  labels.push({ x: 96.5, anchor: 'start', str: value.charAt(11) });
  return { modules: enc.modules, descend: enc.descend, labels: labels, textStyle: 'inline' };
}

function encodeEan8(value) {
  var left = '';
  for (var i = 0; i < 4; i++) left += L_CODES[Number(value.charAt(i))];
  var modules = GUARD_EDGE + left + GUARD_MID + _rightHalf(value.slice(4)) + GUARD_EDGE;
  var labels = _cells(3, value.slice(0, 4), 0).concat(_cells(36, value.slice(4), 0));
  return { modules: modules, descend: [[0, 3], [31, 36], [64, 67]], labels: labels, textStyle: 'inline' };
}

// ─── Validation ──────────────────────────────────────────────────────────────

var EAN_LEN = { ean13: 13, ean8: 8, upca: 12 };
var SYMBOLOGY_NAME = { ean13: 'EAN-13', ean8: 'EAN-8', upca: 'UPC-A', code128: 'Code 128' };

// Spaces and hyphens are how people write a printed number down, so they are
// stripped rather than refused.
function _digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/[\s-]/g, '');
}

// 13 digits -> EAN-13, 12 -> UPC-A (the retail reading of twelve digits),
// 8 -> EAN-8, anything else -> Code 128, which holds any printable ASCII.
function pickSymbology(raw) {
  var digits = _digitsOnly(raw);
  if (/^[0-9]+$/.test(digits)) {
    if (digits.length === 13) return 'ean13';
    if (digits.length === 12) return 'upca';
    if (digits.length === 8) return 'ean8';
  }
  return 'code128';
}

// Returns { value } or { error, hint }. A body one digit short of the symbology
// gets its check digit computed, which is what people expect when they type the
// number off a spreadsheet.
function normalizeEan(raw, kind) {
  var name = SYMBOLOGY_NAME[kind];
  var full = EAN_LEN[kind];
  var digits = _digitsOnly(raw);
  if (!digits) return { error: 'Type the number this ' + name + ' should carry.' };
  if (!/^[0-9]+$/.test(digits)) {
    return { error: name + ' holds digits only. Code 128 takes letters too.' };
  }
  if (digits.length === full - 1) return { value: digits + eanCheckDigit(digits) };
  if (digits.length !== full) {
    return {
      error: name + ' needs ' + full + ' digits, or ' + (full - 1) + ' to have the check digit worked out. This one has '
        + digits.length + '.',
    };
  }
  var body = digits.slice(0, full - 1);
  var want = eanCheckDigit(body);
  if (want !== Number(digits.charAt(full - 1))) {
    return {
      // Not "the last digit of a EAN-13": the name is written into the sentence,
      // so the sentence carries no article.
      error: name + ' ends in a check digit, and this one does not match the rest of the number.',
      hint: 'Did you mean ' + body + want + '?',
    };
  }
  return { value: digits };
}

// Outer whitespace is trimmed, never encoded. A pasted cell carries a trailing
// newline or a stray space, and a space is a real Code 128 character: encoded,
// it would put an invisible character in the scanned string that the printed
// line under the bars does not show.
function normalizeCode128(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return { error: 'Type the text this Code 128 should carry.' };
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c < 32 || c > 126) {
      var shown = c === 9 ? 'a tab' : c === 10 || c === 13 ? 'a line break' : '"' + text.charAt(i) + '"';
      return { error: 'Code 128 cannot hold ' + shown + ' (character ' + (i + 1) + '). Use plain ASCII text.' };
    }
  }
  return { value: text };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Colour values arrive from URL params and land raw inside SVG attributes, so
// only a real hex form is accepted; anything else falls back.
function _hex(v, fb) {
  var s = (v == null ? '' : String(v)).trim().toLowerCase();
  var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  var m6 = /^#?([0-9a-f]{6})$/.exec(s);
  return m6 ? '#' + m6[1] : fb;
}

function _num(v, fb, lo, hi) {
  var n = Number(v);
  if (!Number.isFinite(n)) n = fb;
  return Math.min(hi, Math.max(lo, n));
}

function _r(n) {
  return String(Math.round(n * 100) / 100);
}

var MONO_STACK = 'ui-monospace, Menlo, Consolas, monospace';

// The panel is 600 units wide with a 40-unit margin each side, and its note is
// set at 17: about 61 characters of sans-serif fit on a line. Wrap at 56 so the
// estimate has room to be wrong.
var PANEL_W = 600;
var PANEL_CHARS = 56;
var PANEL_LINE = 26;

// Greedy word wrap. The messages name a symbology and a length, so their length
// is not fixed, and an inline <svg> clips what runs past its viewBox: one long
// line loses its own beginning and end.
function _wrapLines(text, max) {
  var words = String(text).split(/\s+/);
  var lines = [];
  var line = '';
  for (var i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    var next = line ? line + ' ' + words[i] : words[i];
    if (line && next.length > max) {
      lines.push(line);
      line = words[i];
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A visible placeholder when the value cannot be encoded. Without it the canvas
// blanks with nothing to read: onInit/onInput swallow hook errors.
function errorSvg(note, hint) {
  var lines = _wrapLines(note, PANEL_CHARS);
  var body = '';
  var y = 140;
  for (var i = 0; i < lines.length; i++) {
    body += '<text x="300" y="' + (y + i * PANEL_LINE) + '" text-anchor="middle" font-family="sans-serif" '
      + 'font-size="17" fill="#111111">' + _esc(lines[i]) + '</text>';
  }
  var last = y + (lines.length - 1) * PANEL_LINE;
  if (hint) {
    last += 36;
    body += '<text x="300" y="' + last + '" text-anchor="middle" font-family="' + MONO_STACK
      + '" font-size="17" fill="#111111">' + _esc(hint) + '</text>';
  }
  var h = Math.max(260, last + 60);
  return '<svg class="bc-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + PANEL_W + ' ' + h + '" '
    + 'preserveAspectRatio="xMidYMid meet" role="img" aria-label="Barcode unavailable">'
    + '<rect x="0" y="0" width="' + PANEL_W + '" height="' + h + '" rx="12" fill="#fff5f5"/>'
    + '<text x="300" y="96" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#bd3314">Barcode unavailable</text>'
    + body
    + '</svg>';
}

function _inDescend(ranges, start) {
  for (var i = 0; i < ranges.length; i++) {
    if (start >= ranges[i][0] && start < ranges[i][1]) return true;
  }
  return false;
}

function buildSvg(enc, opts) {
  var mw = opts.moduleWidth;
  var quiet = opts.quiet;
  var n = enc.modules.length;
  var inline = enc.textStyle === 'inline';
  var showText = opts.showText && enc.labels.length > 0;

  var top = 2 * mw;
  var barBottom = top + opts.barHeight;
  // Guard bars run past the field so the printed digits sit in the gutter they
  // leave. Without the digits there is nothing for them to make room for.
  var descend = showText && inline ? 5 * mw : 0;
  var guardBottom = barBottom + descend;
  var fontPx = 6 * mw;
  var baseline;
  var height;
  if (!showText) {
    height = barBottom + 2 * mw;
  } else if (inline) {
    baseline = guardBottom;
    height = guardBottom + 1.5 * mw;
  } else {
    baseline = barBottom + 7 * mw;
    height = barBottom + 9 * mw;
    // One centred line under the bars: shrink it rather than let a long value
    // run out of the field.
    var natural = 0.62 * fontPx * enc.labels[0].str.length;
    var room = n * mw * 0.94;
    if (natural > room) fontPx = fontPx * (room / natural);
  }

  var bars = '';
  var i = 0;
  while (i < n) {
    if (enc.modules.charAt(i) !== '1') { i++; continue; }
    var run = 1;
    while (i + run < n && enc.modules.charAt(i + run) === '1') run++;
    var bottom = _inDescend(enc.descend, i) ? guardBottom : barBottom;
    bars += '<rect x="' + _r(i * mw) + '" y="' + _r(top) + '" width="' + _r(run * mw)
      + '" height="' + _r(bottom - top) + '"/>';
    i += run;
  }

  var texts = '';
  var minX = -quiet;
  var maxX = n + quiet;
  if (showText) {
    for (var k = 0; k < enc.labels.length; k++) {
      var lab = enc.labels[k];
      var wModules = 0.62 * (fontPx / mw) * lab.str.length;
      var from = lab.anchor === 'end' ? lab.x - wModules : lab.anchor === 'start' ? lab.x : lab.x - wModules / 2;
      if (from < minX) minX = from;
      if (from + wModules > maxX) maxX = from + wModules;
      texts += '<text x="' + _r(lab.x * mw) + '" y="' + _r(baseline) + '" text-anchor="' + lab.anchor + '">'
        + _esc(lab.str) + '</text>';
    }
  }

  var x0 = minX * mw;
  var width = (maxX - minX) * mw;
  return '<svg class="bc-svg" xmlns="http://www.w3.org/2000/svg" viewBox="' + _r(x0) + ' 0 ' + _r(width) + ' ' + _r(height)
    + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + _esc(opts.summary) + '">'
    + '<rect x="' + _r(x0) + '" y="0" width="' + _r(width) + '" height="' + _r(height) + '" fill="' + opts.background + '"/>'
    + '<g fill="' + opts.color + '" shape-rendering="crispEdges">' + bars + '</g>'
    + (texts ? '<g fill="' + opts.color + '" font-family="' + MONO_STACK + '" font-size="' + _r(fontPx) + '">' + texts + '</g>' : '')
    + '</svg>';
}

// ─── Hook plumbing ───────────────────────────────────────────────────────────

var SYMBOLOGIES = ['auto', 'ean13', 'ean8', 'upca', 'code128'];

function _fail(note, hint, kind) {
  return {
    svgContent: errorSvg(note, hint),
    bgHex: '#fff5f5',
    inkHex: '#111111',
    bcError: note,
    bcHint: hint || '',
    bcSymbology: kind,
    bcValue: '',
    bcModules: '',
    bcSymbols: '',
    bcCheck: '',
    bcSummary: 'nothing yet',
  };
}

function _summary(kind, value) {
  return SYMBOLOGY_NAME[kind] + ' ' + value;
}

// One-entry memo keyed on the whole args object: every input is covered by
// construction, so there is no per-input list to keep in step.
var _memoKey = null;
var _memoResult = null;

function compute(args) {
  var key = JSON.stringify(args);
  if (key === _memoKey) return _memoResult;

  var asked = SYMBOLOGIES.indexOf(args.symbology) >= 0 ? args.symbology : 'auto';
  var kind = asked === 'auto' ? pickSymbology(args.value) : asked;

  var norm = kind === 'code128' ? normalizeCode128(args.value) : normalizeEan(args.value, kind);
  var result;
  if (norm.error) {
    result = _fail(norm.error, norm.hint, kind);
  } else {
    var enc = kind === 'code128' ? encodeCode128(norm.value)
      : kind === 'ean13' ? encodeEan13(norm.value)
      : kind === 'upca' ? encodeUpca(norm.value)
      : encodeEan8(norm.value);
    var background = _hex(args.background, '#ffffff');
    var color = _hex(args.color, '#111111');
    var transparentBg = args.transparentBg === true;
    var summary = _summary(kind, norm.value);
    result = {
      svgContent: buildSvg(enc, {
        moduleWidth: _num(args.moduleWidth, 3, 1, 10),
        barHeight: _num(args.barHeight, 160, 20, 400),
        // 11 modules: the widest quiet zone the four symbologies ask for (EAN-13
        // wants 11 on the left, Code 128 wants 10, UPC-A 9, EAN-8 7), so one
        // symmetric number satisfies all of them. Matches the manifest default.
        quiet: Math.round(_num(args.quiet, 11, 0, 24)),
        showText: args.showText !== false,
        background: transparentBg ? 'none' : background,
        color: color,
        summary: summary,
      }),
      bgHex: transparentBg ? 'transparent' : background,
      inkHex: color,
      bcError: '',
      bcHint: '',
      bcSymbology: kind,
      bcValue: norm.value,
      bcModules: enc.modules,
      bcSymbols: enc.symbols ? enc.symbols.join(',') : '',
      bcCheck: kind === 'code128' ? String(enc.check) : norm.value.slice(-1),
      bcSummary: summary,
    };
  }

  _memoKey = key;
  _memoResult = result;
  return _memoResult;
}

  return function (args) {
    try { return compute(args); }
    catch (err) {
      var msg = (err && err.message) ? err.message : "Could not build this barcode";
      return _fail(msg, "", "code128");
    }
  };
})();

// A throw in a payload builder must not reach the runtime: onInit/onInput
// swallow errors, so the canvas would go blank with nothing to read.
function _run(model) {
  var args = Object.fromEntries(model.map(function(i) { return [i.id, i.value]; }));
  if (BARCODE_KINDS.indexOf(args.payload) >= 0) {
    args.symbology = args.payload;   // computeBarcode reads args.symbology (folded barcode, plans/147 T7a)
    return computeBarcode(args);
  }
  try {
    return compute(args);
  } catch (err) {
    var msg = (err && err.message) ? err.message : 'Could not generate QR code';
    return _fail(msg, _KINDS.indexOf(args.payload) >= 0 ? args.payload : 'url', '');
  }
}

function onInit({ model }) {
  return _run(model);
}

function onInput({ model }) {
  return _run(model);
}

function beforeExport({ format, opts }) {
  // Clear the container background for alpha-capable formats so the SVG's
  // fill:none background rect isn't composited onto an opaque canvas.
  var alphaFormats = ['png', 'webp', 'avif'];
  if (_transparentBg && alphaFormats.includes(format)) {
    opts.background = 'transparent';
  }
}
