"""Regenerate the 0.6.0 test fixtures (pip install reportlab pillow; PIL needs raqm for Arabic shaping).

    python3 test/fixtures/make-v06-fixtures.py
"""
import io
import os
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), "v06")
os.makedirs(OUT, exist_ok=True)
LATIN = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
ARABIC = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"


def text_image(lines, size=(1100, 700), font_size=40):
    img = Image.new("L", size, 255)
    d = ImageDraw.Draw(img)
    y = 50
    for text, lang in lines:
        if lang == "ar":
            f = ImageFont.truetype(ARABIC, font_size)
            w = d.textlength(text, font=f, direction="rtl", language="ar")
            d.text((size[0] - 60 - w, y), text, font=f, fill=0, direction="rtl", language="ar")
        else:
            d.text((60, y), text, font=ImageFont.truetype(LATIN, font_size), fill=0)
        y += int(font_size * 1.9)
    return img


EN_SCAN = [("Scanned page of the self study", "en"), ("Faculty members reviewed the plan", "en"), ("Results were approved in March", "en")]


def png_bytes(img):
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def draw_image_page(c, img):
    w, h = A4
    c.drawImage(ImageReader(io.BytesIO(png_bytes(img))), 40, h - 40 - 500, width=w - 80, height=500 * (w - 80) / 785)


# 1) 141-page mixed PDF: 138 digital pages + scanned pages 10, 70, 140.
c = canvas.Canvas(os.path.join(OUT, "mixed-141.pdf"), pagesize=A4)
scan = text_image(EN_SCAN)
for n in range(1, 142):
    if n in (10, 70, 140):
        draw_image_page(c, scan)
    else:
        t = c.beginText(60, 780)
        t.setFont("Helvetica", 12)
        t.textLine(f"Chapter {n}: programme review")
        t.textLine("The committee confirmed the institutional accredi-")
        t.textLine("tation timeline and the quality standards.")
        t.textLine("")
        t.textLine("")
        t.textLine(f"Second paragraph on page {n} lists the evidence collected.")
        c.drawText(t)
    c.showPage()
c.save()

# 2) Corrupted text layer: page 2 shows correct text as an image, its (invisible) text layer is garbage.
c = canvas.Canvas(os.path.join(OUT, "corrupted-layer.pdf"), pagesize=A4)
t = c.beginText(60, 780)
t.setFont("Helvetica", 12)
t.textLine("Page one has a clean text layer about accreditation standards.")
c.drawText(t)
c.showPage()
draw_image_page(c, text_image([("Accreditation standards are reviewed", "en"), ("annually by the quality committee", "en")]))
t = c.beginText(60, 780)
t.setTextRenderMode(3)
t.setFont("Helvetica", 12)
t.textLine("Acc#editation st@ndards a%e rev$ewed ann&ally b# the qu@lity c%mmittee")
c.drawText(t)
c.showPage()
c.save()

# 3) Mixed EN/AR scan (image + single-page PDF) and an Arabic-only scan.
mixed = text_image([("Annual quality report 2024", "en"), ("تقرير الجودة السنوي للجامعة", "ar"), ("Program outcomes were measured", "en"), ("نتائج البرامج الأكاديمية", "ar")], size=(1100, 900))
mixed.save(os.path.join(OUT, "mixed-en-ar-scan.png"))
c = canvas.Canvas(os.path.join(OUT, "mixed-en-ar-scan.pdf"), pagesize=A4)
draw_image_page(c, mixed)
c.showPage()
c.save()
text_image([("تقرير الاعتماد الأكاديمي", "ar"), ("كلية الطب والعلوم الصحية", "ar")]).save(os.path.join(OUT, "ar-scan.png"))

# 4) Image formats: 2-frame LZW TIFF, BMP, GIF, WebP.
f1 = text_image([("First TIFF frame text", "en")], size=(900, 300))
f2 = text_image([("Second TIFF frame text", "en")], size=(900, 300))
f1.save(os.path.join(OUT, "two-frames.tif"), save_all=True, append_images=[f2], compression="tiff_lzw")
f1.resize((450, 150)).save(os.path.join(OUT, "frame.bmp"))
f1.save(os.path.join(OUT, "frame.gif"))
f1.save(os.path.join(OUT, "frame.webp"), quality=90)
print("fixtures written to", OUT)
