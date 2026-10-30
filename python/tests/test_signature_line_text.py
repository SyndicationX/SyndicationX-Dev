import unittest

import fitz

from app.services.signature_line_text import nearby_texts


class SignatureLineTextTests(unittest.TestCase):
    def test_reads_the_name_beside_each_signature_line(self) -> None:
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        page.insert_text((220, 410), "Douglas J Chupella")
        page.insert_text((220, 470), "Sonja Kuperus, Manager")
        pdf = doc.tobytes()
        doc.close()

        found = nearby_texts(
            pdf,
            [
                {"index": 3, "page": 1, "x": 72, "y": 380, "width": 140, "height": 36},
                {"index": 4, "page": 1, "x": 72, "y": 440, "width": 140, "height": 36},
            ],
        )
        by_index = {row["index"]: row["text"] for row in found}
        self.assertIn("Douglas", by_index[3])
        self.assertIn("Chupella", by_index[3])
        self.assertIn("Sonja", by_index[4])
        self.assertNotIn("Sonja", by_index[3])
