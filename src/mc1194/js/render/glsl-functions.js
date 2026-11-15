// Deliberately small GLSL function selector. GLSL itself is compiled by the GPU, never evaluated as JavaScript.
export function selectGLSLFunctions(source,root){
 const tokens=[];const lex=/\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*|[A-Za-z_]\w*|[^\s]/gm;let m;
 while((m=lex.exec(source)))if(!m[0].startsWith('/*')&&!m[0].startsWith('//')&&!m[0].trimStart().startsWith('#'))tokens.push({text:m[0],start:m.index,end:lex.lastIndex});
 const match=(at,open,close)=>{let depth=0;for(let j=at;j<tokens.length;j++){if(tokens[j].text===open)depth++;if(tokens[j].text===close&&!--depth)return j;}throw Error('Unbalanced GLSL '+open);};
 const functions=new Map(),constants=new Map();let depth=0;
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i];
  if(!depth&&t.text==='const'){
   let j=i;while(j<tokens.length&&tokens[j].text!==';')j++;if(j===tokens.length)throw Error('Unterminated GLSL constant');
   constants.set(tokens[i+2]?.text,{start:t.start,end:tokens[j].end,text:source.slice(t.start,tokens[j].end)});i=j;continue;
  }
  if(!depth&&t.text==='('&&i>=2&&/^[A-Za-z_]\w*$/.test(tokens[i-1].text)){
   const endParams=match(i,'(',')');if(tokens[endParams+1]?.text==='{'){
    const end=match(endParams+1,'{','}'),name=tokens[i-1].text;
    if(functions.has(name))throw Error('GLSL function overloads are not supported by the selector: '+name);
    functions.set(name,{start:tokens[i-2].start,end:tokens[end].end,text:source.slice(tokens[i-2].start,tokens[end].end)});i=end;continue;
   }
  }
  if(t.text==='{')depth++;if(t.text==='}')depth--;
 }
 if(!functions.has(root))throw Error('Missing GLSL entry function: '+root);
 const selected=new Map();const visit=name=>{
  if(selected.has(name))return;const item=functions.get(name)||constants.get(name);if(!item)return;selected.set(name,item);
  for(const word of item.text.match(/[A-Za-z_]\w*/g)||[])if(word!==name)visit(word);
 };visit(root);
 return {source:[...selected.values()].sort((a,b)=>a.start-b.start).map(v=>v.text).join('\n'),functions:[...selected.keys()].filter(k=>functions.has(k))};
}

// The block.properties subset used by BSL: version comparisons, continuations and block-state selectors.
export function shaderBlockRules(source,version){
 const lines=source.replace(/\\\r?\n/g,' ').split(/\r?\n/),stack=[],rules=[];let active=true;
 const condition=s=>{const m=/^MC_VERSION\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(s.trim());if(!m)throw Error('Unsupported block.properties condition: '+s);const n=Number(m[2]);return m[1]==='>='?version>=n:m[1]==='<='?version<=n:m[1]==='=='?version===n:m[1]==='>'?version>n:version<n;};
 for(const line of lines){
  const d=/^\s*#(if|elif|else|endif)\b\s*(.*)$/.exec(line);
  if(d){const [,op,expr]=d;if(op==='if'){const yes=condition(expr);stack.push({parent:active,taken:yes});active=active&&yes;}else{const top=stack.at(-1);if(!top)throw Error('Unmatched block.properties '+op);if(op==='endif'){active=top.parent;stack.pop();}else{const yes=op==='else'||condition(expr);active=top.parent&&!top.taken&&yes;top.taken||=yes;}}continue;}
  if(!active)continue;const rule=/^\s*block\.(\d+)\s*=\s*(.*)$/.exec(line);if(!rule)continue;
  const id=Number(rule[1]);if(id>65535)throw Error('Block animation ID exceeds packed lookup range');
  for(const selector of rule[2].split(/\s+/).filter(Boolean)){const parts=selector.split(':');if(parts[1]&&!parts[1].includes('=')&&parts[0]!=='minecraft')continue;const name=parts[0]==='minecraft'?parts[1]:parts[0],properties={};for(const p of parts.slice(parts[0]==='minecraft'?2:1)){const [key,value]=p.split('=');if(!key||!value)throw Error('Unsupported block selector: '+selector);properties[key]=value.split(',');}rules.push({id,name,properties});}
 }
 if(stack.length)throw Error('Unclosed block.properties conditional');return rules;
}
export function animationLookup(rules,states){
 const data=new Uint8Array(256*Math.ceil(states.length/256)*4),byName=new Map();for(const r of rules){if(!byName.has(r.name))byName.set(r.name,[]);byName.get(r.name).push(r);}
 for(const state of states){let id=0;for(const r of byName.get(state.name)||[])if(Object.entries(r.properties).every(([key,values])=>values.includes(String(state.properties[key]))))id=r.id;
  data[state.id*4]=id&255;data[state.id*4+1]=id>>8;data[state.id*4+3]=255;
 }return {width:256,height:Math.ceil(states.length/256),data};
}

// Desktop GLSL also permits mixing integer SYMBOLS with float operands (frame_mod * 5.0,
// viewHeight / 1080, intVar == 1.5); GLSL ES 3.0 rejects every one of these, even inside
// never-called helpers. glslImplicitFloat wraps declared integer/boolean symbols (plus
// integer-valued #define macros and typed function parameters) in float() where they
// directly meet a float operand, and stamps .0 onto int literals beside float
// symbols/macros. Only mixed lines are touched, so already-valid packs compile
// byte-identically. Preprocessor lines are skipped.
export function glslImplicitFloat(source){
  const floatNames=new Set(),intNames=new Set(),uintNames=new Set();
  const def=(type,name)=>{( /^uint/.test(type)?uintNames:/^(float|vec)/.test(type)?floatNames:intNames).add(name);};
  for(const m of source.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+(-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?)(?=[ \t]*(?:\/\/|$))/gm))floatNames.add(m[1]);
  for(const m of source.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+(-?\d+)(?=[ \t]*(?:\/\/|$))/gm))if(!floatNames.has(m[1]))intNames.add(m[1]);
  for(const m of source.matchAll(/^[ \t]*(?:uniform[ \t]+)?(?:const[ \t]+)?(?:(?:highp|mediump|lowp)[ \t]+)?(float|int|uint|bool|vec[234]|ivec[234])[ \t]+([^;{}()=]*)(?:=[^;]*)?;/gm)){
    const set=/^uint/.test(m[1])?uintNames:/^(float|vec)/.test(m[1])?floatNames:intNames;
    for(const part of m[2].split(',')){const name=/^\s*([A-Za-z_]\w*)/.exec(part);if(name)set.add(name[1]);}
  }
  for(const m of source.matchAll(/[(,]\s*(float|int|uint|bool|vec[234]|ivec[234])\s+([A-Za-z_]\w*)\s*[,)]/g))def(m[1],m[2]);
  for(const name of [...uintNames])if(intNames.has(name)||floatNames.has(name)){intNames.delete(name);floatNames.delete(name);}
  if(!intNames.size&&!floatNames.size&&!uintNames.size)return source;
  const esc=s=>s.replace(/[^\w]/g,'\\$&');
  const long=list=>[...list].filter(n=>n.length>1).map(esc).join('|');
  const op='(?:\\*|\\/|\\+|\\-|<=|>=|==|!=|<|>)';
  const num='(?:\\d+\\.\\d*|\\.\\d+)';
  const fLong=long(floatNames),iLong=long(intNames),uLong=long(uintNames);
  const rawGuard=n=>n?'(?<![\\w.])(?:'+n+')(?![\\w.])':null;
  const guard=n=>{const g=rawGuard(n);return g?g+'(?!\\s*\\()':null;};
  const fGuard=guard(fLong),iGuard=guard(iLong),uGuard=guard(uLong);
  // Function-scoped uint resolution: a name like "value" can be uint in one
  // function and int in another. Global uint membership alone rewrites valid
  // code (uint(0) into an int comparison). Resolve per line instead.
  const uScope=(()=>{
    const clean=source.replace(/\/\*[\s\S]*?\*\//g,s=>s.replace(/[^\n]/g,' ')).replace(/\/\/[^\n]*/g,s=>s.replace(/[^\n]/g,' ')).split('\n');
    const raw=source.split('\n'),at=new Array(raw.length).fill(-1),funcs=[];
    const cont=new Array(raw.length).fill(false);{let c=false;for(let i=0;i<raw.length;i++){cont[i]=c;const cc=clean[i].match(/(\\+)$/);c=!!cc&&cc[1].length%2===1;}}
    let depth=0,cur=-1;
    const isHead=code=>/^\s*(?:[\w:]+\s+)+(\w+)\s*\([^;{}]*\)\s*\{\s*$/.test(code)&&!/^\s*(?:if|for|while|switch|do)\b/.test(code);
    for(let i=0;i<raw.length;i++){
      const code=clean[i];
      if(cont[i]||/^\s*#/.test(code))continue;
      if(depth===0&&isHead(code)){cur=funcs.length;funcs.push({head:code,start:i});}
      if(cur>=0)at[i]=cur;
      depth+=(code.match(/\{/g)||[]).length-(code.match(/\}/g)||[]).length;
      if(cur>=0&&depth<=0){funcs[cur].end=i;cur=-1;depth=0;}
    }
    const kind=t=>/^uint/.test(t)?'u':/^(float|vec)/.test(t)?'f':'o';
    const local=(text,all)=>{for(const m of text.matchAll(/(float|int|uint|bool|vec[234]|ivec[234])\s+([^;{}()=]*)(?:=[^;]*)?;/g))for(const part of m[2].split(',')){const n=/^\s*([A-Za-z_]\w*)/.exec(part);if(n)all.push([n[1],kind(m[1])]);}};
    const params=(head,all)=>{const p=/\(([^()]*)\)/.exec(head);if(!p)return;for(const part of p[1].split(',')){const m=/(float|int|uint|bool|vec[234]|ivec[234])\s+([A-Za-z_]\w*)/.exec(part);if(m)all.push([m[2],kind(m[1])]);}};
    const shadows=funcs.map(f=>{const all=[];params(f.head,all);for(let i=f.start+1;i<=(f.end??f.start);i++){if(cont[i]||/^\s*#/.test(clean[i]))continue;local(clean[i],all);}return new Set(all.filter(([,k])=>k!=='u').map(([n])=>n));});
    return {at,shadows};
  })();
  const uGuardCache=new Map();
  const uGuardFor=idx=>{
    const fi=uScope.at[idx];
    if(fi===undefined||fi<0)return uGuard;
    if(uGuardCache.has(fi))return uGuardCache.get(fi);
    const sh=uScope.shadows[fi],names=[...uintNames].filter(n=>n.length>1&&!sh.has(n)).map(esc).join('|');
    const g=guard(names);
    uGuardCache.set(fi,g);return g;
  };
  const fOperand=fLong?'(?:'+num+'|'+rawGuard(fLong)+')':'(?:'+num+')';
  const chainIn='(?:[A-Za-z_]\\w*\\s*\\.\\s*)*(?:'+iLong+')';
  const chain='('+chainIn+')';
  const grp='\\([^()]*(?:'+num+'|'+(fGuard||'(?!)')+')[^()]*\\)';
  const uOp='(?:\\*|\\/|\\+|\\-|<=|>=|==|!=|<|>|%)';
  const gOp='(?:\\*|\\/|\\+|\\-)';
  return source.split('\n').map((line,idx)=>{
    const uGuard=uGuardFor(idx);
    if(/^[ \t]*#/.test(line))return line;
    if(iLong&&fLong){
      line=line.replace(new RegExp('('+iGuard+')(\\s*'+op+'\\s*)('+fOperand+')','g'),'float($1)$2$3').replace(new RegExp('('+fOperand+')(\\s*'+op+'\\s*)('+iGuard+')','g'),'$1$2float($3)');
    }
    if(uLong&&iLong){
      line=line.replace(new RegExp('('+uGuard+')(\\s*'+uOp+'\\s*)('+chain+')','g'),'$1$2uint($3)').replace(new RegExp('('+chain+')(\\s*'+uOp+'\\s*)('+uGuard+')','g'),'uint($1)$2$3');
      line=line.replace(new RegExp('('+uGuard+')(\\s*'+uOp+'\\s*)(\\d+)(?![\\w.])','g'),'$1$2uint($3)').replace(new RegExp('(?<![\\w.])(\\d+)(\\s*'+uOp+'\\s*)('+uGuard+')','g'),'uint($1)$2$3');
      line=line.replace(new RegExp('('+uGuard+')(\\s*(?:<<=|>>=|/=|%=|\\+=|-=|\\*=|&=|\\|=|\\^=)\\s*)('+chainIn+'|\\d+|int\\s*\\([^;]*\\))','g'),'$1$2uint($3)');
      line=line.replace(new RegExp('('+uGuard+')(\\s*=\\s*)('+chainIn+'|\\d+|int\\s*\\([^;]*\\))(\\s*;)','g'),'$1$2uint($3)$4');
    }
    if(fGuard){
      line=line.replace(new RegExp('('+fGuard+')(\\s*=\\s*)(int\\s*\\([^;]*\\)|-?\\d+|-?'+chainIn+')(\\s*;)','g'),'$1$2float($3)$4');
      line=line.replace(new RegExp('(?<![\\w.])(\\d+)(\\s*'+op+'\\s*'+fGuard+')','g'),'$1.0$2').replace(new RegExp('('+fGuard+'\\s*'+op+'\\s*)(\\d+)(?![\\w.])','g'),'$1$2.0');
    }
      line=line.replace(new RegExp('(?<![\\w.])(\\d+)(\\s*'+gOp+'\\s*)('+grp+')','g'),'$1.0$2$3').replace(new RegExp('('+grp+')(\\s*'+gOp+'\\s*)(\\d+)(?![\\w.])','g'),'$1$2$3.0');
    if(iGuard){
      line=line.replace(new RegExp('('+iGuard+')(\\s*'+gOp+'\\s*)('+grp+')','g'),'float($1)$2$3').replace(new RegExp('('+grp+')(\\s*'+gOp+'\\s*)('+iGuard+')','g'),'$1$2float($3)');
    }
    return line;
  }).join('\n');
}
// Small desktop-to-ES numeric bridge: desktop GLSL permits int literals next to float/vector symbols.
// Preserve integer loop counters and indices; remaining type checking belongs to the GLSL compiler.
export function glslFloatLiterals(source){
  const names=[...new Set([...source.matchAll(/\b(?:float|vec[234]|mat[234])\s+([A-Za-z_]\w*)/g)].map(m=>m[1]))];
  if(!names.length)return source;const symbols='(?:'+names.join('|')+')';
  return source.replace(new RegExp('(?<![\\w.])(\\d+)\\s*([*/+\\-])\\s*('+symbols+')\\b','g'),'$1.0 $2 $3').replace(new RegExp('\\b('+symbols+')\\s*([*/+\\-])\\s*(\\d+)(?![.\\w])','g'),'$1 $2 $3.0');
}
