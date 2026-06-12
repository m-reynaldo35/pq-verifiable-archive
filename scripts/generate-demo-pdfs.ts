import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';

interface DocSpec {
  filename: string;
  title: string;
  parties: [string, string];
  clauses: { heading: string; body: string }[];
}

const docs: DocSpec[] = [
  {
    filename: 'non-disclosure-agreement.pdf',
    title: 'NON-DISCLOSURE AGREEMENT',
    parties: ['Nexus Ventures Ltd', 'Brightfield Analytics Inc'],
    clauses: [
      {
        heading: '1. Definition of Confidential Information',
        body: 'For purposes of this Agreement, "Confidential Information" means any data or information that is proprietary to the Disclosing Party and not generally known to the public, whether in tangible or intangible form, including but not limited to technical data, trade secrets, research, product plans, products, services, customers, markets, software, developments, and inventions.',
      },
      {
        heading: '2. Obligations of Receiving Party',
        body: 'The Receiving Party agrees to hold the Confidential Information in strict confidence, to not disclose it to any third party without prior written consent of the Disclosing Party, and to use the Confidential Information solely for the purpose of evaluating a potential business relationship between the parties.',
      },
      {
        heading: '3. Term',
        body: 'This Agreement shall remain in effect for a period of three (3) years from the Effective Date. The obligations of confidentiality shall survive the termination or expiration of this Agreement.',
      },
      {
        heading: '4. Governing Law',
        body: 'This Agreement shall be governed by and construed in accordance with the laws of England and Wales, without regard to conflicts of law principles.',
      },
    ],
  },
  {
    filename: 'employment-contract.pdf',
    title: 'EMPLOYMENT CONTRACT',
    parties: ['Meridian Group PLC', 'Jordan K. Whitfield'],
    clauses: [
      {
        heading: '1. Position and Duties',
        body: 'The Employee is engaged as Senior Software Engineer and shall perform such duties as are customarily associated with such position, including but not limited to designing, developing, and maintaining software systems, and such other duties as may be reasonably assigned by the Employer from time to time.',
      },
      {
        heading: '2. Compensation',
        body: 'The Employer shall pay the Employee an annual base salary of £85,000, payable in equal monthly instalments on the last business day of each calendar month. The Employee shall be eligible for an annual performance bonus at the Employer\'s discretion.',
      },
      {
        heading: '3. Intellectual Property',
        body: 'All work product, inventions, and developments created by the Employee in the course of employment shall be the sole and exclusive property of the Employer. The Employee hereby assigns to the Employer all right, title, and interest in and to such work product.',
      },
      {
        heading: '4. Termination',
        body: 'Either party may terminate this Agreement by providing three (3) months written notice to the other party. The Employer reserves the right to pay salary in lieu of notice. Summary dismissal may occur in cases of gross misconduct.',
      },
    ],
  },
  {
    filename: 'software-license-agreement.pdf',
    title: 'SOFTWARE LICENSE AGREEMENT',
    parties: ['Orbital Systems Ltd', 'Cascade Financial Services Ltd'],
    clauses: [
      {
        heading: '1. Grant of License',
        body: 'Orbital Systems Ltd ("Licensor") hereby grants to Cascade Financial Services Ltd ("Licensee") a non-exclusive, non-transferable, limited license to install and use the Licensor\'s proprietary software platform ("Software") solely for the Licensee\'s internal business operations, for the term set out herein.',
      },
      {
        heading: '2. Restrictions',
        body: 'The Licensee shall not copy, modify, translate, adapt, or create derivative works of the Software; reverse engineer, disassemble, or decompile the Software; sublicense, sell, resell, transfer, or otherwise make the Software available to any third party; or remove any proprietary notices or labels on the Software.',
      },
      {
        heading: '3. Fees and Payment',
        body: 'The Licensee shall pay the annual license fee of £24,000 in advance on the commencement date of each year of the license term. All fees are exclusive of VAT. Late payments shall accrue interest at 4% above the Bank of England base rate.',
      },
      {
        heading: '4. Limitation of Liability',
        body: 'In no event shall the Licensor be liable for any indirect, incidental, special, consequential, or punitive damages. The Licensor\'s total cumulative liability shall not exceed the fees paid by the Licensee in the twelve months preceding the claim.',
      },
    ],
  },
  {
    filename: 'partnership-agreement.pdf',
    title: 'PARTNERSHIP AGREEMENT',
    parties: ['Thornwood Capital Partners LLP', 'Elara Property Group Ltd'],
    clauses: [
      {
        heading: '1. Formation and Purpose',
        body: 'The parties hereby agree to form a limited partnership for the purpose of acquiring, developing, managing, and disposing of real estate assets in the United Kingdom. The partnership shall operate under the name "Thornwood Elara Real Estate LP" and shall be registered in accordance with the Limited Partnerships Act 1907.',
      },
      {
        heading: '2. Capital Contributions',
        body: 'Thornwood Capital Partners LLP shall contribute £5,000,000 representing 60% of the initial capital. Elara Property Group Ltd shall contribute £3,333,333 representing 40% of the initial capital. Additional capital contributions may be made by mutual written agreement of the partners.',
      },
      {
        heading: '3. Profit and Loss Distribution',
        body: 'Net profits and losses of the partnership shall be allocated to the partners in proportion to their respective capital contributions, being 60% to Thornwood Capital Partners LLP and 40% to Elara Property Group Ltd, unless otherwise agreed in writing.',
      },
      {
        heading: '4. Dissolution',
        body: 'The partnership shall be dissolved upon unanimous written agreement of all partners, or upon the occurrence of an event making it unlawful for the partnership business to be continued. On dissolution, assets shall be liquidated and proceeds distributed in accordance with capital contribution percentages.',
      },
    ],
  },
  {
    filename: 'consulting-services-agreement.pdf',
    title: 'CONSULTING SERVICES AGREEMENT',
    parties: ['Vantage Advisory Ltd', 'Stratford Manufacturing PLC'],
    clauses: [
      {
        heading: '1. Scope of Services',
        body: 'Vantage Advisory Ltd ("Consultant") agrees to provide strategic operational consulting services to Stratford Manufacturing PLC ("Client"), including process optimisation analysis, supply chain review, and implementation roadmap development, as further detailed in Schedule A attached hereto and incorporated by reference.',
      },
      {
        heading: '2. Fees and Expenses',
        body: 'The Client shall pay the Consultant a monthly retainer of £12,500, invoiced on the first business day of each month, payable within 30 days of invoice date. Pre-approved expenses shall be reimbursed within 14 days of submission. The Consultant shall provide monthly expense reports with supporting documentation.',
      },
      {
        heading: '3. Independent Contractor',
        body: 'The Consultant is an independent contractor and not an employee, agent, or partner of the Client. The Consultant shall have full control over the manner and means of providing the Services, subject to meeting agreed deliverables and timelines. The Consultant is solely responsible for all taxes on its compensation.',
      },
      {
        heading: '4. Confidentiality and Non-Solicitation',
        body: 'The Consultant shall maintain the confidentiality of all Client information for a period of two (2) years following termination. During the term and for twelve (12) months thereafter, the Consultant shall not solicit or employ any employee or contractor of the Client.',
      },
    ],
  },
];

function generatePdf(spec: DocSpec, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, size: 'A4' });
    const stream = createWriteStream(outputPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - 144;
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text(spec.title, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`Dated: ${today}`, { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1.5);

    // Parties
    doc.fontSize(11).font('Helvetica-Bold').text('PARTIES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    doc.text(`This Agreement is entered into between:`);
    doc.moveDown(0.3);
    doc.text(`(1)  ${spec.parties[0]} ("Party A"); and`);
    doc.moveDown(0.2);
    doc.text(`(2)  ${spec.parties[1]} ("Party B").`);
    doc.moveDown(1.5);

    // Clauses
    for (const clause of spec.clauses) {
      doc.fontSize(11).font('Helvetica-Bold').text(clause.heading);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(clause.body, { width: pageWidth, align: 'justify' });
      doc.moveDown(1.2);
    }

    // Signature blocks
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text('EXECUTED AS AN AGREEMENT');
    doc.moveDown(1);

    const colWidth = pageWidth / 2 - 20;
    const startY = doc.y;

    // Party A
    doc.fontSize(10).font('Helvetica-Bold').text('Signed for and on behalf of', 72, startY, { width: colWidth });
    doc.font('Helvetica').text(spec.parties[0], 72, doc.y, { width: colWidth });
    doc.moveDown(2.5);
    doc.moveTo(72, doc.y).lineTo(72 + colWidth, doc.y).stroke();
    doc.moveDown(0.3);
    doc.text('Authorised Signatory', 72, doc.y, { width: colWidth });
    doc.moveDown(0.2);
    doc.text('Name: _______________________', 72, doc.y, { width: colWidth });
    doc.moveDown(0.2);
    doc.text('Date:  _______________________', 72, doc.y, { width: colWidth });

    // Party B
    const rightCol = 72 + colWidth + 40;
    doc.fontSize(10).font('Helvetica-Bold').text('Signed for and on behalf of', rightCol, startY, { width: colWidth });
    doc.font('Helvetica').text(spec.parties[1], rightCol, startY + 14, { width: colWidth });
    doc.moveDown(0);
    const sigY = startY + 80;
    doc.moveTo(rightCol, sigY).lineTo(rightCol + colWidth, sigY).stroke();
    doc.text('Authorised Signatory', rightCol, sigY + 6, { width: colWidth });
    doc.text('Name: _______________________', rightCol, sigY + 20, { width: colWidth });
    doc.text('Date:  _______________________', rightCol, sigY + 34, { width: colWidth });

    // Footer
    doc.fontSize(8).fillColor('#888888')
      .text('CONFIDENTIAL — FOR DEMONSTRATION PURPOSES ONLY', 72, doc.page.height - 50, {
        align: 'center', width: pageWidth,
      });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function main() {
  await mkdir('assets/demo-contracts', { recursive: true });
  for (const spec of docs) {
    const path = `assets/demo-contracts/${spec.filename}`;
    await generatePdf(spec, path);
    console.log(`Generated: ${path}`);
  }
  console.log('Done — 5 demo PDFs written to assets/demo-contracts/');
}

main().catch(e => { console.error(e); process.exit(1); });
