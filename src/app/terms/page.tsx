import type { Metadata } from "next";
import { getBrand } from "@/config/brand";
import { LegalPage } from "@/components/landing/LegalPage";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms on which you may use this website to ask for roofing quotes.",
};

export default function TermsPage() {
  const brand = getBrand();
  return (
    <LegalPage title="Terms of use">
      <p>
        These terms apply when you use this website, operated by {brand.legalName} (company number {brand.companyNumber}), to ask
        for roofing quotes.
      </p>

      <h2>What we do</h2>
      <p>
        {brand.name} is an introduction service. When you send an enquiry we pass it to a roofing business that covers your area.
        We are not a roofing company, we do not carry out roofing work, and we are not a party to any agreement between you and a
        roofing business.
      </p>

      <h2>Using the service</h2>
      <ul>
        <li>The service is free for you to use.</li>
        <li>Please give accurate details and only submit enquiries about property you are entitled to ask work to be done on.</li>
        <li>You are never obliged to accept a quote or to use the roofing business we introduce.</li>
        <li>
          We cannot guarantee that a roofing business will contact you, or how quickly, or that you will agree a price.
        </li>
      </ul>

      <h2>Roofing businesses</h2>
      <p>
        Roofing businesses are independent. Any quote, contract, guarantee or insurance is between you and that business. Please
        check a business&apos;s credentials, insurance and references before agreeing work.
      </p>

      <h2>Our responsibility</h2>
      <p>
        We take reasonable care in running this website, but we do not accept responsibility for the work, advice or conduct of
        roofing businesses. Nothing in these terms limits any liability that cannot be limited by law, including your statutory
        consumer rights.
      </p>

      <h2>Law</h2>
      <p>These terms are governed by the law of England and Wales.</p>

      <h2>Contact</h2>
      <p>
        {brand.legalName}, {brand.registeredAddress}. Privacy questions: <a href={`mailto:${brand.privacyEmail}`}>{brand.privacyEmail}</a>.
      </p>
    </LegalPage>
  );
}
