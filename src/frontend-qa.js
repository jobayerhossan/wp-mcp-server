/* Pure, browser-free analysis of reports collected by the JAI inspector. */
const allowedStyles = new Set(['display','position','visibility','opacity','width','height','minWidth','maxWidth','padding','margin','gap','rowGap','columnGap','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','color','backgroundColor','alignItems','justifyContent','flexDirection','flexWrap','gridTemplateColumns','overflowX','overflowY','objectFit','objectPosition','borderRadius','boxSizing']);
function assertReport(report) {
  if (!report || report.schema !== 'wpmcp.frontend.v1' || !Array.isArray(report.elements) || !report.viewport) throw Error('Expected a wpmcp.frontend.v1 browser report');
  if (report.elements.length > 400) throw Error('Maximum 400 elements per report');
  return report;
}
function near(actual, expected, tolerance=2) {
  const a=Number(actual), b=Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a-b)<=tolerance : String(actual)===String(expected);
}
export function auditFrontend(report) {
  report=assertReport(report);
  const issues=[...(Array.isArray(report.problems)?report.problems.slice(0,100):[])];
  const {viewport,elements}=report;
  if (viewport.documentWidth>viewport.width+2 && !issues.some(x=>x.type==='horizontal_overflow')) issues.push({type:'horizontal_overflow',amount:viewport.documentWidth-viewport.width});
  for(const e of elements) {
    if(e.tag==='img' && e.image?.complete && !e.image.naturalWidth && !issues.some(x=>x.type==='broken_image' && x.id===e.id)) issues.push({type:'broken_image',id:e.id});
    if(['button','a','input','select','textarea'].includes(e.tag) && e.rect?.width>0 && e.rect?.height>0 && Number(e.styles?.opacity)===0) issues.push({type:'invisible_interactive_element',id:e.id});
  }
  return {url:report.url,viewport,checked:elements.length,issues:issues.slice(0,150),passed:issues.length===0,notes:['Passing automated checks does not establish pixel-perfect visual fidelity.','Overlaps and intentional offscreen elements may require visual review.']};
}
export function compareFrontend(report,expectations=[]) {
  assertReport(report);
  if(!Array.isArray(expectations) || expectations.length>100) throw Error('Expected up to 100 comparisons');
  const checks=expectations.map((rule,i)=>{
    const match=report.elements.find(e=>e.id===rule.id || rule.className && e.classes?.split(/\s+/).includes(rule.className));
    if(!match) return {index:i,id:rule.id??null,passed:false,reason:'element_not_found'};
    const key=String(rule.property||'');
    const geometry=['x','y','width','height'];
    if(!geometry.includes(key) && !allowedStyles.has(key)) return {index:i,id:match.id,passed:false,reason:'unsupported_property'};
    const actual=geometry.includes(key)?match.rect?.[key]:match.styles?.[key];
    const passed=near(actual,rule.expected,rule.tolerance??2);
    return {index:i,id:match.id,property:key,expected:rule.expected,actual,passed};
  });
  return {url:report.url,checked:checks.length,passed:checks.every(x=>x.passed),checks};
}
export function verifyFrontend(previous,current,expectations=[]) {
  assertReport(previous);assertReport(current);
  if(previous.url!==current.url) throw Error('Verification requires the same URL');
  const before=auditFrontend(previous),after=auditFrontend(current);
  const comparison=compareFrontend(current,expectations);
  return {url:current.url,before_issues:before.issues.length,after_issues:after.issues.length,resolved_issue_count:Math.max(0,before.issues.length-after.issues.length),checks:comparison,passed:after.passed && comparison.passed,notes:['Verify at the same viewport and browser environment for comparable results.']};
}
