import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface HeroProps {
  title?: string;
  description?: string;
  Icon?: LucideIcon;
  children: ReactNode;
}

function Hero({
  title,
  description,
  Icon,
  children,
}: HeroProps) {
  return (
    <div className="hero w-full h-full sm:p-4 p-1">
      <div className="hero-content flex-col lg:flex-row-reverse sm:gap-8 gap-1 w-full max-sm:p-2">
        {
          title && (
            <div className="text-center lg:text-left shrink-0 lg:max-w-[50%]">

              <div className="flex items-center flex-col sm:flex-row justify-center lg:justify-start gap-3 mb-2 max-sm:mb-0">
                { Icon && <Icon size={40} className="text-primary" /> }
                <h1 className="text-5xl max-sm:text-2xl font-bold">{ title }</h1>
              </div>
              <p className="py-6 max-sm:pt-2">
                { description }
              </p>
            </div>
          )
        }
        <div className="max-w-lg w-[calc(100vw-4rem)] max-sm:w-[95%] shrink-0">
          <div className="card bg-base-100">
            { children }
          </div>
        </div>
      </div>
    </div>
  );
}

export default Hero;
