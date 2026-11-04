import os, io, json, resvg_py
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image
O='/workspace/vibeship-design/brand'; INK='#111111'; CREAM='#f3eee4'; ORG='#e85d04'; DARK='#111111'
def mark_body(stroke, jib_fill, sail=ORG, sw=5, small=False):
    if small:
        return f'''<g fill="none" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round">
<path d="M46 8L94 58H46Z" fill="{sail}"/><path d="M8 64H120L104 110H24Z"/><path d="M50 78V96M78 78V96"/></g>'''
    s=f'stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"'
    if small:  # 64-unit grid scaled to 128
        ribs=''.join(f'<path d="M{x} 76V97"/>' for x in (40,60))
        door='<path d="M84 76H100V96H84Z"/>'
    else:
        ribs=''.join(f'<path d="M{x} 74V99"/>' for x in range(30,82,9))
        door='<path d="M86 74H102V97H86Z M86 81.5H102 M86 89H102"/>'
    return f'''<g fill="none" {s}>
<path d="M42 12L72 40V58H42Z" fill="{sail}"/>
<path d="M72 40L96 58H72Z" fill="{jib_fill}"/>
<path d="M42 12V58"/>
<path d="M10 66L22 57H114L118 66Z" fill="{jib_fill}"/>
<path d="M10 66H118L104 104H24Z"/>
{ribs}{door}</g>'''
def svg(w,h,inner,vb=None,bg=None):
    b=f'<rect width="100%" height="100%" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb or f"0 0 {w} {h}"}">{b}{inner}</svg>\n'
MARK=lambda **k: mark_body(**k)
f=TTFont('/workspace/fonts/fonts/ttf/JetBrainsMono-Medium.ttf'); gs=f.getGlyphSet(); cmap=f.getBestCmap(); upm=f['head'].unitsPerEm
def word(fill, size=64, x0=0, base=0):
    sc=size/upm; x=0; ds=[]
    for ch in 'vibeship':
        g=cmap[ord(ch)]; p=SVGPathPen(gs)
        gs[g].draw(TransformPen(p,(sc,0,0,-sc,x0+x*sc,base))); ds.append(p.getCommands()); x+=gs[g].width
    return f'<path fill="{fill}" d="{" ".join(ds)}"/>', x*sc
W=lambda fill,size,x0,base: word(fill,size,x0,base)
files={}
files['vibeship-mark.svg']=svg(128,128,MARK(stroke=INK,jib_fill='#ffffff'))
files['vibeship-mark-mono.svg']=svg(128,128,MARK(stroke=INK,jib_fill='none',sail=INK))
files['vibeship-mark-inverse.svg']=svg(128,128,MARK(stroke=CREAM,jib_fill='none'))
files['favicon.svg']=f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="-2 -6 132 132"><rect x="-2" y="-6" width="132" height="132" rx="22" fill="{CREAM}"/>'+mark_body(INK,'#ffffff',sw=10,small=True)+'</svg>\n'
def horiz(stroke,jib,txt):
    wp,ww=W(txt,72,150,96); return svg(int(150+ww+8),128,MARK(stroke=stroke,jib_fill=jib)+wp)
files['vibeship-logo-horizontal.svg']=horiz(INK,'#ffffff',INK)
files['vibeship-logo-horizontal-inverse.svg']=horiz(CREAM,'none',CREAM)
wp,ww=W(INK,56,0,170); files['vibeship-logo-stacked.svg']=svg(int(ww),190,f'<g transform="translate({ww/2-64} 0)">{MARK(stroke=INK,jib_fill="#ffffff")}</g>'+wp)
wp,ww=W(INK,72,0,72); files['vibeship-wordmark.svg']=svg(int(ww),92,wp)
for n,c in files.items(): open(f'{O}/{n}','w').write(c)
def png(s,w,h=None,path=None):
    import re
    s=re.sub(r'<svg ([^>]*?)width="[^"]*" height="[^"]*"',lambda m:f'<svg {m.group(1)}width="{w}" height="{h or w}"',s,1)
    b=bytes(resvg_py.svg_to_bytes(svg_string=s)); im=Image.open(io.BytesIO(b)).convert('RGBA')
    if path: im.save(path)
    return im
def wh(s):
    import re; m=re.search(r'width="(\d+)" height="(\d+)"',s); return int(m[1]),int(m[2])
for n in ['vibeship-mark','vibeship-logo-horizontal']:
    s=files[n+'.svg']; w,h=wh(s)
    for k in (1,2,4): png(s,w*k,h*k,f'{O}/{n}@{k}x.png')
fav=files['favicon.svg']
for z in (16,32): png(fav,z,z,f'{O}/favicon-{z}.png')
png(fav,48,48).save(f'{O}/favicon.ico',sizes=[(16,16),(32,32),(48,48)])
inner=mark_body(INK,'#ffffff')
def padded(size,pad,bg,path):
    k=(1-2*pad)*size/128
    s=svg(size,size,f'<g transform="translate({pad*size} {pad*size}) scale({k})">{inner}</g>',bg=bg); png(s,size,size,path)
padded(180,.12,CREAM,f'{O}/apple-touch-icon.png'); padded(192,.08,None,f'{O}/icon-192.png'); padded(512,.08,None,f'{O}/icon-512.png'); padded(512,.2,CREAM,f'{O}/icon-512-maskable.png')
# og
lw,lh=wh(files['vibeship-logo-horizontal.svg']); k=1.2; x=(1200-lw*k)/2
tp,tw=word(INK,1,0,0)  # unused
inner_logo=files['vibeship-logo-horizontal.svg'].split('>',1)[1].rsplit('</svg>',1)[0]
og=svg(1200,630,f'<g transform="translate({x} 220) scale({k})">{inner_logo}</g><text x="600" y="460" text-anchor="middle" font-family="JetBrains Mono" font-size="28" fill="#5c5c5c">ship it to your own box</text>',bg=CREAM)
# outline tagline too
def text_path(t,fill,size,cx,base):
    sc=size/upm; tot=sum(gs[cmap[ord(c)]].width for c in t)*sc; x=cx-tot/2; ds=[]
    for c in t:
        g=cmap[ord(c)]; p=SVGPathPen(gs); gs[g].draw(TransformPen(p,(sc,0,0,-sc,x,base))); ds.append(p.getCommands()); x+=gs[g].width*sc
    return f'<path fill="{fill}" d="{" ".join(ds)}"/>'
og=og.replace(og[og.index('<text'):og.index('</text>')+7],text_path('ship it to your own box','#5c5c5c',28,600,460))
open(f'{O}/og-image.svg','w').write(og); png(og,1200,630,f'{O}/og-image.png')
# preview
sheet=Image.new('RGB',(1600,1200),'#ffffff'); 
from PIL import ImageDraw; d=ImageDraw.Draw(sheet); d.rectangle([0,600,1600,1200],fill=DARK); d.rectangle([0,0,1600,600],fill=CREAM)
def put(im,x,y,hh):
    im=im.copy(); im.thumbnail((10000,hh)); sheet.paste(im,(x,y),im)
def r(n,h): s=files[n]; w,hh=wh(s); return png(s,int(w*h/hh*2),h*2)
put(r('vibeship-mark.svg',160),40,40,160); put(r('vibeship-mark-mono.svg',160),240,40,160)
put(r('vibeship-logo-horizontal.svg',120),460,60,120); put(r('vibeship-logo-stacked.svg',200),40,240+120-120,200)
put(r('vibeship-wordmark.svg',80),420,300,80)
for i,z in enumerate((16,32,48)): put(png(fav,z,z),1000+i*70,330,z)
put(Image.open(f'{O}/apple-touch-icon.png').convert('RGBA'),1240,280,180)
put(Image.open(f'{O}/icon-512-maskable.png').convert('RGBA'),1240,40,180)
put(r('vibeship-mark-inverse.svg',160),40,660,160); put(r('vibeship-logo-horizontal-inverse.svg',120),260,680,120)
put(Image.open(f'{O}/og-image.png').convert('RGBA'),40,860,320)
put(Image.open(f'{O}/favicon-32.png').convert('RGBA').resize((128,128),Image.NEAREST),700,900,128)
put(Image.open(f'{O}/favicon-16.png').convert('RGBA').resize((128,128),Image.NEAREST),860,900,128)
sheet.save(f'{O}/preview.png')
json.dump({"name":"Vibeship","short_name":"Vibeship","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/icon-512-maskable.png","sizes":"512x512","type":"image/png","purpose":"maskable"}],"theme_color":"#f3eee4","background_color":"#f3eee4","display":"standalone"},open(f'{O}/site.webmanifest','w'),indent=2)
