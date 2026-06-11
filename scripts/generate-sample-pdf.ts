import PDFDocument from 'pdfkit';
import { createWriteStream, statSync } from 'fs';
import { resolve } from 'path';

const OUTPUT_PATH = resolve(process.cwd(), 'assets', 'sample-contract.pdf');

function buildContract(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 72 });
    const stream = createWriteStream(OUTPUT_PATH);
    doc.pipe(stream);

    // Header
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .text('SERVICE AGREEMENT', { align: 'center' });
    doc.moveDown(1.5);

    // Preamble / parties
    doc
      .font('Helvetica')
      .fontSize(11)
      .text(
        'This Service Agreement (the "Agreement") is entered into as of June 11, 2026 ' +
          '(the "Effective Date") by and between:',
        { align: 'left' }
      );
    doc.moveDown(0.75);
    doc
      .font('Helvetica-Bold')
      .text('Acme Corp', { continued: true })
      .font('Helvetica')
      .text(
        ', a Delaware corporation with its principal place of business at ' +
          '100 Innovation Way, Wilmington, DE 19801 ("Provider"); and'
      );
    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .text('Widget Ltd', { continued: true })
      .font('Helvetica')
      .text(
        ', a company registered in England and Wales with its registered office at ' +
          '42 Commerce Street, London EC1A 1BB ("Client").'
      );
    doc.moveDown(0.5);
    doc.text(
      'Provider and Client are each a "Party" and together the "Parties." In consideration ' +
        'of the mutual covenants set out below, the Parties agree as follows:'
    );
    doc.moveDown(1);

    const clause = (n: number, title: string, body: string) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(`${n}. ${title}`);
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(11).text(body, { align: 'justify' });
      doc.moveDown(0.75);
    };

    clause(
      1,
      'Services',
      'Provider shall perform the professional services described in any statement of work ' +
        'agreed by the Parties (the "Services"). Provider shall perform the Services in a ' +
        'professional and workmanlike manner consistent with generally accepted industry standards.'
    );
    clause(
      2,
      'Payment',
      'In consideration of the Services, Client shall pay Provider the fees set out in the ' +
        'applicable statement of work. Unless otherwise stated, all invoices are due within thirty ' +
        '(30) days of the invoice date. Late amounts accrue interest at 1.5% per month or the ' +
        'maximum rate permitted by law, whichever is lower.'
    );
    clause(
      3,
      'Confidentiality',
      'Each Party may receive confidential information of the other Party. The receiving Party ' +
        'shall use such information solely to perform under this Agreement and shall protect it with ' +
        'no less than reasonable care. This obligation survives termination for a period of three (3) years.'
    );
    clause(
      4,
      'Term',
      'This Agreement commences on the Effective Date and continues for an initial term of twelve ' +
        '(12) months, renewing automatically for successive twelve (12) month terms unless either ' +
        'Party gives sixty (60) days written notice of non-renewal. Either Party may terminate for ' +
        'material breach that remains uncured thirty (30) days after written notice.'
    );

    doc.moveDown(1);
    doc
      .font('Helvetica')
      .fontSize(11)
      .text(
        'IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.'
      );
    doc.moveDown(2);

    // Signature blocks
    const sigBlock = (party: string, name: string) => {
      const x = doc.x;
      doc.font('Helvetica-Bold').text(party);
      doc.moveDown(1.5);
      doc.font('Helvetica').text('______________________________');
      doc.font('Helvetica').fontSize(10).text(`Name: ${name}`);
      doc.text('Title: Authorized Signatory');
      doc.text('Date: ____________________');
      doc.fontSize(11);
      doc.x = x;
      doc.moveDown(1.5);
    };

    sigBlock('PROVIDER — Acme Corp', 'Jordan Avery');
    sigBlock('CLIENT — Widget Ltd', 'Morgan Blake');

    // Footer
    doc.moveDown(2);
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#666666')
      .text('CONFIDENTIAL — FOR DEMONSTRATION PURPOSES ONLY', { align: 'center' });

    doc.end();

    stream.on('finish', () => resolvePromise());
    stream.on('error', reject);
  });
}

async function main() {
  await buildContract();
  const { size } = statSync(OUTPUT_PATH);
  console.log(`Wrote ${OUTPUT_PATH} (${size} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
