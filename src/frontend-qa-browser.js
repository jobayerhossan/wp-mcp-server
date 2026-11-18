/* Run in the browser console on a page you own or are authorized to inspect.
   Stores the report in window.__JAI_FRONTEND_REPORT and copies JSON where clipboard access permits. */
(async function () {
  const properties = ['display','position','visibility','opacity','width','height','minWidth','maxWidth','padding','margin','gap','rowGap','columnGap','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','color','backgroundColor','alignItems','justifyContent','flexDirection','flexWrap','gridTemplateColumns','overflowX','overflowY','objectFit','objectPosition','borderRadius','boxSizing'];
  const select = '[data-id],header,footer,main,section,h1,h2,h3,button,a,input,textarea,select,img,.elementor-widget,.elementor-container';
  const els = [...document.querySelectorAll(select)].slice(0, 400);
  const idOf = (el, i) => el.getAttribute('data-id') || el.id || el.getAttribute('data-elementor-id') || el.tagName.toLowerCase() + ':' + i;
  const items = els.map((el, i) => {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    const styles = Object.fromEntries(properties.map(k => [k, css[k]]));
    const image = el.tagName === 'IMG' ? {src: new URL(el.currentSrc || el.src).pathname, naturalWidth:el.naturalWidth, naturalHeight:el.naturalHeight, complete:el.complete} : undefined;
    return {id:idOf(el,i),tag:el.tagName.toLowerCase(),classes:String(el.className?.baseVal ?? el.className ?? '').slice(0,160),text:(el.innerText || el.alt || '').trim().replace(/\s+/g,' ').slice(0,100),rect:{x:+r.x.toFixed(1),y:+r.y.toFixed(1),width:+r.width.toFixed(1),height:+r.height.toFixed(1)},styles, ...(image ? {image} : {})};
  });
  const viewport = {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,devicePixelRatio};
  const problems = [];
  if (viewport.documentWidth > viewport.width + 2) problems.push({type:'horizontal_overflow',amount:viewport.documentWidth-viewport.width});
  for (const item of items) {
    if (item.rect.width > 0 && item.rect.x < -2) problems.push({type:'offscreen_left',id:item.id});
    if (item.rect.width > 0 && item.rect.x+item.rect.width > innerWidth+2 && item.styles.position !== 'fixed') problems.push({type:'offscreen_right',id:item.id});
    if (item.image && item.image.complete && !item.image.naturalWidth) problems.push({type:'broken_image',id:item.id});
  }
  const report = {schema:'wpmcp.frontend.v1',url:location.origin+location.pathname,createdAt:new Date().toISOString(),viewport,elements:items,problems:problems.slice(0,100)};
  window.__JAI_FRONTEND_REPORT=report;
  const json=JSON.stringify(report);
  try {await navigator.clipboard.writeText(json); console.log('JAI Frontend report copied to clipboard',report);} catch {console.log('JAI Frontend report ready. Copy JSON below:',json);}
  return report;
})();