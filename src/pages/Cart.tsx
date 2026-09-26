import React, { useState, useEffect } from 'react';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { formatCurrency, calculateDistance, formatSizeLabel, geocodeBrazilianAddress, normalizeText } from '../lib/utils';
import { collection, addDoc, doc, onSnapshot } from 'firebase/firestore';
import { db, sanitizeForFirestore } from '../lib/firebase';
import { notifyAdminsOfNewOrder } from '../lib/push';
import { createPixPayment } from '../lib/pix';
import { useNavigate } from 'react-router-dom';
import { Trash2, MapPin, Phone, User as UserIcon, Edit2, CreditCard, DollarSign, QrCode, MessageSquare, MessageCircle, AlertCircle, Check, X, Image as ImageIcon, Truck, ShoppingBag, UtensilsCrossed, Store, Gift, Star } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { CompanyInfo, ServiceType, LoyaltyReward } from '../types';
import { ProductModal } from '../components/ProductModal';
import { isStoreOpen } from '../lib/openingHours';

export default function Cart() {
  const { items, removeItem, total, clearCart } = useCart();
  const { user, updateUser } = useAuth();
  const [address, setAddress] = useState(user?.address || '');
  const [serviceType, setServiceType] = useState<ServiceType>('delivery');
  const [tableNumber, setTableNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'credit' | 'debit' | 'cash'>('pix');
  const [needChange, setNeedChange] = useState<boolean | null>(null);
  const [changeFor, setChangeFor] = useState('');
  const [notes, setNotes] = useState('');
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const navigate = useNavigate();
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [pendingWhatsappOrder, setPendingWhatsappOrder] = useState<{ orderId: string; whatsappUrl: string } | null>(null);
  const [selectedRewardId, setSelectedRewardId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'company_info'), (snapshot) => {
      if (snapshot.exists()) {
        setCompanyInfo(snapshot.data() as CompanyInfo);
      }
    });
    return () => unsub();
  }, []);

  const [alertState, setAlertState] = useState<{
    type: 'success' | 'error' | 'warning';
    message: string;
    submessage?: string;
  } | null>(null);

  useEffect(() => {
    if (alertState) {
      const timer = setTimeout(() => {
        setAlertState(null);
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [alertState]);

  const isProfileIncomplete = serviceType === 'delivery' 
    ? (!user?.phone || !user?.address)
    : !user?.phone;

  const { calculatedDeliveryFee, isNeighborhoodExplicitlyAllowed, isCityServed } = React.useMemo(() => {
    if (serviceType !== 'delivery') return { calculatedDeliveryFee: 0, isNeighborhoodExplicitlyAllowed: false, isCityServed: true };

    // Case/accent-insensitive, and tolerant of extra whitespace or minor
    // wording differences either side (e.g. customer's "Vila Sao Joao,
    // perto do posto" vs the admin's registered "Vila São João") — an
    // exact-only match was silently falling back to the base delivery
    // fee for any real-world typo/variation instead of the bairro rate.
    const normalize = normalizeText;

    // The store's registered city is a reliable, non-geocoded signal for
    // "do we deliver here at all" — it comes straight from the CEP lookup
    // (now locked in Profile.tsx, so it can't be hand-edited wrong), not
    // from the free geocoding service that has real coverage gaps and
    // caused a false "1081km away" rejection for a customer whose street
    // simply wasn't mapped. A different municipality entirely is blocked
    // by this city check; a customer in the right city whose bairro just
    // isn't registered yet is not (see deliveryFeePending below).
    const cityMatches = !companyInfo?.addressCity || !user?.addressCity ? true : (() => {
      const nc = normalize(user.addressCity);
      const cc = normalize(companyInfo.addressCity);
      return nc === cc || nc.includes(cc) || cc.includes(nc);
    })();

    if (companyInfo?.neighborhoodFees && user?.addressNeighborhood && cityMatches) {
      const normalizedUser = normalize(user.addressNeighborhood);

      // An exact match always wins. Otherwise, among substring matches,
      // the longest (most specific) registered name wins — picking
      // whichever entry happened to come first in the list let a short,
      // generic bairro name (e.g. "São João") shadow a more specific one
      // that's a superset of it ("Vila São João"), silently charging the
      // wrong delivery fee for any customer whose real neighborhood
      // contained the generic name as a substring.
      let match = companyInfo.neighborhoodFees.find(nh => normalize(nh.name) === normalizedUser);
      if (!match) {
        const candidates = companyInfo.neighborhoodFees
          .map(nh => ({ nh, normalizedName: normalize(nh.name) }))
          .filter(({ normalizedName }) => normalizedName && (
            normalizedUser.includes(normalizedName) || normalizedName.includes(normalizedUser)
          ));
        candidates.sort((a, b) => b.normalizedName.length - a.normalizedName.length);
        match = candidates[0]?.nh;
      }
      if (match) {
        return { calculatedDeliveryFee: match.fee, isNeighborhoodExplicitlyAllowed: true, isCityServed: true };
      }
    }
    return { calculatedDeliveryFee: companyInfo?.deliveryFee || 0, isNeighborhoodExplicitlyAllowed: false, isCityServed: cityMatches };
  }, [serviceType, companyInfo, user?.addressNeighborhood, user?.addressCity]);

  const userPoints = user?.points || 0;
  const availableRewards = companyInfo?.loyaltyEnabled ? (companyInfo.loyaltyRewards || []) : [];
  const selectedReward: LoyaltyReward | null = selectedRewardId
    ? availableRewards.find(r => r.id === selectedRewardId) || null
    : null;

  const preDiscountTotal = total + calculatedDeliveryFee;
  const computeRewardDiscount = (reward: LoyaltyReward) =>
    reward.discountType === 'percent' ? preDiscountTotal * (reward.discountValue / 100) : reward.discountValue;

  const rewardDiscount = selectedReward ? computeRewardDiscount(selectedReward) : 0;
  const displayFinalTotal = Math.max(0, preDiscountTotal - rewardDiscount);

  // Among the rewards the customer can actually afford, flag whichever one
  // saves them the most money so they don't have to compare percent vs.
  // fixed discounts themselves.
  const bestRewardId = React.useMemo(() => {
    const affordable = availableRewards.filter(r => userPoints >= r.pointsCost);
    if (affordable.length < 2) return null;
    let best = affordable[0];
    for (const r of affordable.slice(1)) {
      if (computeRewardDiscount(r) > computeRewardDiscount(best)) best = r;
    }
    return best.id;
  }, [availableRewards, userPoints, preDiscountTotal]);

  // Keep address synchronized with user profile data when loaded/changed
  useEffect(() => {
    if (user?.address) {
      setAddress(user.address);
    }
  }, [user?.address]);

  const handleCheckout = async () => {
    if (!user) return;
    if (items.length === 0) return;

    const status = isStoreOpen(companyInfo);
    if (!status.isOpen && user?.role !== 'admin') {
      setAlertState({
        type: 'error',
        message: 'Estabelecimento Fechado',
        submessage: status.reason
      });
      return;
    }

    if (isProfileIncomplete) {
      setAlertState({
        type: 'warning',
        message: 'Dados Incompletos',
        submessage: serviceType === 'delivery'
          ? 'Preencha seus dados de contato e endereço antes de finalizar. Redirecionando...'
          : 'Preencha seu telefone/WhatsApp no perfil antes de finalizar. Redirecionando...'
      });
      setTimeout(() => {
        navigate('/profile');
      }, 3000);
      return;
    }

    if (serviceType === 'delivery' && !isCityServed) {
      setAlertState({
        type: 'error',
        message: 'Fora da área de entrega',
        submessage: `Infelizmente ainda não entregamos em ${user?.addressCity || 'sua cidade'}. Nossas entregas são feitas apenas em ${companyInfo?.addressCity || 'nossa cidade'}.`
      });
      return;
    }

    const parsedChangeFor = (paymentMethod === 'cash' && needChange === true)
      ? parseFloat(changeFor.replace(',', '.')) || null
      : null;

    setLoading(true);

    let finalDeliveryFee = calculatedDeliveryFee;
    let deliveryFeePending = false;

    // A bairro that isn't on the registered fee list is never allowed to
    // block the order — a false "fora da área" rejection is a lost sale,
    // and free geocoding has real coverage gaps for minor Brazilian
    // streets (this is exactly what produced a customer's false
    // "1081km away" rejection). Instead the order goes through flagged
    // for the admin to set the fee and confirm it with the customer.
    // Distance is still computed best-effort below, purely to keep the
    // customer's stored coordinates fresh and for diagnostics/logging —
    // it can no longer stop checkout.
    if (serviceType === 'delivery' && !isNeighborhoodExplicitlyAllowed) {
      deliveryFeePending = true;
    }

    if (serviceType === 'delivery' && companyInfo?.deliveryRadiusKm && !isNeighborhoodExplicitlyAllowed) {
      let restaurantLat = companyInfo?.lat;
      let restaurantLng = companyInfo?.lng;

      if (!restaurantLat || !restaurantLng) {
        if (companyInfo?.addressStreet && companyInfo?.addressCity) {
          const geo = await geocodeBrazilianAddress({
            street: companyInfo.addressStreet,
            number: companyInfo.addressNumber,
            neighborhood: companyInfo.addressNeighborhood,
            city: companyInfo.addressCity,
            state: companyInfo.addressState,
            zip: companyInfo.addressZip,
          });
          if (geo) {
            restaurantLat = geo.lat;
            restaurantLng = geo.lng;
          }
        }
        if (!restaurantLat || !restaurantLng) {
          restaurantLat = -22.7937;
          restaurantLng = -43.3670;
        }
      }

      // Free geocoding has real coverage gaps for minor Brazilian streets —
      // this backs off through progressively broader (but still real)
      // queries instead of ever falling back to a bare CEP search, which
      // is what produced a customer's reported "1081km away" false
      // positive: her street isn't mapped, and the old CEP-only fallback
      // misparsed the tail of her CEP as an unrelated place in another
      // state entirely.
      const geocodeUserAddress = () => geocodeBrazilianAddress({
        street: user.addressStreet,
        number: user.addressNumber,
        neighborhood: user.addressNeighborhood,
        city: user.addressCity,
        state: user.addressState,
        zip: user.addressZip,
      });

      let userLat = user.lat;
      let userLng = user.lng;
      const hadStoredCoords = !!(userLat && userLng);

      if (!userLat || !userLng) {
        const geo = await geocodeUserAddress();
        if (geo) {
          userLat = geo.lat;
          userLng = geo.lng;
        }
      }

      if (userLat && userLng) {
        let distance = calculateDistance(restaurantLat, restaurantLng, userLat, userLng);

        // A delivery radius is realistically never more than a few dozen
        // km, so a distance in the hundreds of km is a geocoding mismatch,
        // not a genuinely out-of-range customer. Re-check with a fresh
        // geocode (the stored coordinates may predate the state-qualified
        // query above) before deciding, and never block a real local
        // customer on an implausible result either way.
        const SANITY_LIMIT_METERS = 200000; // 200km
        if (distance > SANITY_LIMIT_METERS && hadStoredCoords) {
          const fresh = await geocodeUserAddress();
          if (fresh) {
            userLat = fresh.lat;
            userLng = fresh.lng;
            distance = calculateDistance(restaurantLat, restaurantLng, userLat, userLng);
            if (distance <= SANITY_LIMIT_METERS) {
              // Corrected coordinates look sane now — persist them so future
              // checkouts don't need to re-geocode at all.
              updateUser({ lat: userLat, lng: userLng }).catch(() => {});
            }
          }
        }

        if (distance > SANITY_LIMIT_METERS) {
          console.warn(`Distância calculada de ${(distance / 1000).toFixed(1)}km para o cliente ${user.uid} é implausível (provável erro do serviço de geolocalização gratuito) — pedido segue normalmente, já que o bairro não está na lista cadastrada e a taxa foi marcada para confirmação do admin.`);
        } else if (distance > companyInfo.deliveryRadiusKm * 1000) {
          console.warn(`Pedido do cliente ${user.uid} está a ${(distance/1000).toFixed(1)}km, além do raio configurado (${companyInfo.deliveryRadiusKm}km) — não bloqueado pois o bairro não está na lista cadastrada; taxa marcada para confirmação do admin.`);
        }
      }
    }

    if (selectedReward && userPoints < selectedReward.pointsCost) {
      setAlertState({
        type: 'error',
        message: 'Pontos insuficientes',
        submessage: 'Você não tem pontos suficientes para essa recompensa.'
      });
      setLoading(false);
      return;
    }

    const preDiscountTotal = total + finalDeliveryFee;
    const finalTotal = Math.max(0, preDiscountTotal - rewardDiscount);
    const pointsEarned = companyInfo?.loyaltyEnabled
      ? Math.floor(finalTotal / (companyInfo.loyaltySpendPerPoint || 10)) * (companyInfo.loyaltyPointsPerUnit || 1)
      : 0;

    if (paymentMethod === 'cash' && needChange === true) {
      if (!parsedChangeFor || parsedChangeFor <= finalTotal) {
        setAlertState({
          type: 'error',
          message: 'Troco Inválido',
          submessage: 'Por favor, informe um valor de troco válido e maior que o total do pedido.'
        });
        setLoading(false);
        return;
      }
    }
    
    try {
      const orderAddressText = serviceType === 'delivery'
        ? address
        : serviceType === 'pickup'
        ? `RETIRADA NO LOCAL (${companyInfo?.address || 'Estabelecimento'})`
        : `COMER NO LOCAL${tableNumber.trim() ? ` - Mesa/Identificação: ${tableNumber.trim()}` : ''}`;

      const orderPayload = sanitizeForFirestore({
        userId: user.uid,
        userName: user.name,
        userPhone: user.phone,
        items,
        total: finalTotal,
        deliveryFee: finalDeliveryFee,
        deliveryFeePending: serviceType === 'delivery' ? deliveryFeePending : false,
        serviceType,
        tableNumber: serviceType === 'dine_in' ? (tableNumber.trim() || null) : null,
        status: 'pending_payment',
        paymentMethod,
        changeRequested: paymentMethod === 'cash' && needChange === true,
        changeFor: parsedChangeFor,
        address: orderAddressText,
        notes: notes.trim() || null,
        pointsEarned,
        pointsRedeemed: selectedReward?.pointsCost || 0,
        rewardApplied: selectedReward ? { id: selectedReward.id, label: selectedReward.label, discountAmount: rewardDiscount } : null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const orderRef = await addDoc(collection(db, 'pix_test_orders'), orderPayload);
      // PIX orders reach the admin only after the payment is confirmed (the
      // Mercado Pago webhook sends that push), so an abandoned checkout
      // never rings anyone.
      if (paymentMethod === 'pix') {
        createPixPayment(orderRef.id, finalTotal, user.email || 'cliente@sensacaogourmet-teste.com');
      } else {
        notifyAdminsOfNewOrder(orderRef.id);
      }

      clearCart();
      
      if (companyInfo?.phone && paymentMethod !== 'pix') {
        let paymentStr: string = paymentMethod;
        if (paymentMethod === 'credit') paymentStr = 'Cartão de Crédito';
        else if (paymentMethod === 'debit') paymentStr = 'Cartão de Débito';
        else if (paymentMethod === 'cash') paymentStr = 'Dinheiro';
        
        let typeStr = serviceType === 'delivery' ? 'Delivery' : (serviceType === 'pickup' ? 'Retirada' : 'Mesa');

        const orderText = `*NOVO PEDIDO!* 🛒
*ID:* ${orderRef.id.slice(-6).toUpperCase()}
*Nome:* ${user?.name || 'Cliente'}
*Tipo:* ${typeStr}
${serviceType === 'delivery' ? `*Endereço:* ${orderAddressText}\n` : ''}
*Itens:*
${items.map(item => `${item.quantity}x ${item.product.name}`).join('\n')}

*Subtotal:* ${formatCurrency(total)}
${finalDeliveryFee > 0 ? `*Taxa de Entrega:* ${formatCurrency(finalDeliveryFee)}\n` : ''}${selectedReward ? `*Desconto (${selectedReward.label}):* -${formatCurrency(rewardDiscount)}\n` : ''}*Total:* ${formatCurrency(finalTotal)}
*Pagamento:* ${paymentStr}

*Acompanhe o pedido:*
${window.location.origin}/orders/${orderRef.id}`;

        // wa.me needs the full international number (country code first) —
        // without the "55" prefix the link doesn't resolve to a valid chat.
        const phone = '55' + companyInfo.phone.replace(/\D/g, '');
        const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(orderText)}`;

        // An automatic redirect/window.open right after an async addDoc()
        // call is unreliable — most mobile browsers treat it as an
        // unrequested popup and silently block it, so the WhatsApp message
        // would never actually get sent. Instead, require a real tap on a
        // button (a genuine user gesture, never blocked) before continuing
        // to the order page — this is what makes the step dependable.
        setPendingWhatsappOrder({ orderId: orderRef.id, whatsappUrl });
      } else {
        navigate(`/orders/${orderRef.id}`);
      }
    } catch (error) {
      console.error(error);
      setAlertState({
        type: 'error',
        message: 'Erro ao criar pedido',
        submessage: 'Ocorreu um erro ao finalizar seu pedido. Tente novamente.'
      });
    } finally {
      setLoading(false);
    }
  };

  // clearCart() runs immediately after the order is created (before this
  // modal is shown), so items is always empty by the time we need to show
  // it — it has to be checked ahead of the "cart is empty" screen below,
  // or that screen would always win and the modal would never appear.
  if (pendingWhatsappOrder) {
    return (
      <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
        <motion.div
          initial={{ scale: 0.95, y: 15, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full border border-gray-100"
        >
          <div className="flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-4">
              <MessageCircle size={28} className="stroke-[2.5]" />
            </div>
            <h3 className="text-sm font-black text-gray-900 uppercase tracking-wider mb-2">
              Pedido Registrado!
            </h3>
            <p className="text-xs text-gray-500 font-bold mb-6 leading-relaxed">
              Pra confirmar seu pedido, toque no botão abaixo e envie a mensagem que já preparamos no WhatsApp. É rapidinho!
            </p>
            <button
              onClick={() => {
                window.open(pendingWhatsappOrder.whatsappUrl, '_blank', 'noopener,noreferrer');
                navigate(`/orders/${pendingWhatsappOrder.orderId}`);
                setPendingWhatsappOrder(null);
              }}
              className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md shadow-emerald-600/20 transition-all cursor-pointer active:scale-98 flex items-center justify-center gap-2"
            >
              <MessageCircle size={16} />
              Confirmar no WhatsApp
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Seu carrinho está vazio</h2>
        <button onClick={() => navigate('/')} className="text-brand hover:text-brand-dark font-bold uppercase tracking-widest text-xs">
          Voltar ao cardápio
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-xl font-black text-gray-900 mb-6 uppercase tracking-wider">Carrinho</h1>
      
      {isProfileIncomplete && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-wider">Atenção: Dados Incompletos</p>
            <p className="text-xs mt-1 text-amber-700 font-medium">Você precisa cadastrar seu número de WhatsApp e endereço detalhado para podermos realizar a entrega.</p>
          </div>
          <button 
            onClick={() => navigate('/profile')} 
            className="whitespace-nowrap bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-lg transition-colors"
          >
            Cadastrar Agora
          </button>
        </div>
      )}

      <div className="bg-white shadow-sm overflow-hidden rounded-xl border border-gray-100 mb-6">
        <ul className="divide-y divide-gray-100">
          {items.map((item, index) => (
            <li key={index} className="px-4 py-4 flex justify-between items-center gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {item.product.imageUrl ? (
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-100 shrink-0 border border-gray-200">
                    <img src={item.product.imageUrl} alt={item.product.name} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-gray-100 shrink-0 border border-gray-200 flex items-center justify-center text-gray-300">
                    <ImageIcon size={16} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold text-gray-900 truncate" translate="no">{item.product.name}</h4>
                  
                  {item.customizationSelections ? (
                    <div className="text-[10px] text-gray-500 mt-1 space-y-1">
                      {Object.entries(item.customizationSelections).map(([step, options]) => (
                        options.length > 0 && (
                          <div key={step}>
                            <span className="font-bold">{step}:</span> {options.map(o => o.name).join(', ')}
                          </div>
                        )
                      ))}
                      {item.notes && <div className="italic break-words">Obs: {item.notes}</div>}
                    </div>
                  ) : (
                    (item.selectedSize || (item.selectedOption && item.selectedOption !== 'Nenhum')) && (
                      <p className="text-[10px] text-gray-500 mt-1 uppercase tracking-widest font-bold">
                        {formatSizeLabel(item.selectedSize)}
                        {item.selectedOption && item.selectedOption !== 'Nenhum' && ` • ${item.selectedOption}`}
                      </p>
                    )
                  )}
                  
                  <div className="text-[10px] text-gray-600 mt-1 font-bold">
                    Qtd: {item.quantity}
                  </div>
                </div>
              </div>
              <div className="flex items-center space-x-4 shrink-0">
                <span className="font-black text-gray-900">{formatCurrency(item.totalPrice)}</span>
                <button 
                  onClick={() => removeItem(index)}
                  className="text-gray-400 hover:text-red-600 p-2 rounded-full hover:bg-gray-50 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="bg-gray-50 px-4 py-4 border-t border-gray-100 flex flex-col gap-2">
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500 font-bold">Subtotal</span>
            <span className="font-black text-gray-900">{formatCurrency(total)}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500 font-bold">Taxa de Entrega</span>
            <span className="font-black text-gray-900">
              {serviceType === 'delivery'
                ? (user?.addressNeighborhood && !isNeighborhoodExplicitlyAllowed
                    ? 'Em análise'
                    : (calculatedDeliveryFee > 0 ? formatCurrency(calculatedDeliveryFee) : 'Grátis'))
                : 'Grátis'}
            </span>
          </div>
          {serviceType === 'delivery' && user?.addressNeighborhood && !isNeighborhoodExplicitlyAllowed && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 font-semibold leading-relaxed">
              Seu bairro ainda não está na nossa lista de entrega. Seu pedido será avaliado pelo administrador para confirmar se entregamos aí e qual o valor da taxa — vamos avisar você por telefone/WhatsApp antes de despachar.
            </p>
          )}
          {selectedReward && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-emerald-600 font-bold">Desconto ({selectedReward.label})</span>
              <span className="font-black text-emerald-600">-{formatCurrency(rewardDiscount)}</span>
            </div>
          )}
          <div className="flex justify-between items-center mt-2 pt-2 border-t border-gray-200">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">Total</span>
            <span className="text-lg font-black text-brand">
              {formatCurrency(displayFinalTotal)}
            </span>
          </div>
        </div>
      </div>

      {/* Tipo de Serviço */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-100 p-5 mb-6">
        <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-50 pb-3">
          <Store size={14} className="text-brand" /> Tipo de Serviço
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => setServiceType('delivery')}
            className={`p-3.5 rounded-xl border-2 flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
              serviceType === 'delivery'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Truck size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Entrega em Casa</span>
          </button>

          <button
            type="button"
            onClick={() => setServiceType('pickup')}
            className={`p-3.5 rounded-xl border-2 flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
              serviceType === 'pickup'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <ShoppingBag size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Retirada no Local</span>
          </button>

          <button
            type="button"
            onClick={() => setServiceType('dine_in')}
            className={`p-3.5 rounded-xl border-2 flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
              serviceType === 'dine_in'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <UtensilsCrossed size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Comer no Local</span>
          </button>
        </div>

        {serviceType === 'dine_in' && (
          <div className="mt-4 p-3.5 bg-blue-50/70 rounded-xl border border-blue-100 text-xs space-y-2">
            <p className="font-bold text-blue-900">🍽️ Consumo no Local / Mesa</p>
            <p className="text-blue-800 text-[11px]">Seu pedido será preparado e servido para você na loja.</p>
            <div>
              <label className="block text-[9px] font-black text-blue-900 uppercase tracking-widest mb-1">
                Número da Mesa ou Identificação
              </label>
              <input
                type="text"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                placeholder="Ex: Mesa 04, Balcão 2..."
                className="w-full border border-blue-200 bg-white rounded-lg py-2 px-3 text-xs font-bold text-gray-800 focus:ring-brand focus:border-brand"
              />
            </div>
          </div>
        )}

        {serviceType === 'pickup' && (
          <div className="mt-4 p-3.5 bg-amber-50/70 rounded-xl border border-amber-200 text-xs space-y-1 text-amber-900">
            <p className="font-bold">📍 Retirada no Local</p>
            <p className="text-[11px] leading-relaxed">
              Você buscará seu pedido diretamente no nosso balcão ({companyInfo?.address || 'no estabelecimento'}). Taxa de entrega gratuita!
            </p>
          </div>
        )}
      </div>

      {/* Dados do Cliente / Endereço */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-100 p-5 mb-6">
        <div className="flex justify-between items-center mb-4 border-b border-gray-50 pb-3">
          <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2">
            {serviceType === 'delivery' ? <MapPin size={14} className="text-brand" /> : <UserIcon size={14} className="text-brand" />} 
            {serviceType === 'delivery' ? 'Dados de Entrega' : serviceType === 'pickup' ? 'Dados para Retirada' : 'Dados do Cliente'}
          </h3>
          {!isProfileIncomplete && (
            <button
              onClick={() => navigate('/profile')}
              className="text-[10px] font-bold uppercase tracking-widest text-brand hover:text-brand-dark flex items-center gap-1 transition-colors"
            >
              <Edit2 size={12} /> Alterar
            </button>
          )}
        </div>

        {isProfileIncomplete ? (
          <div className="text-center py-4">
            <p className="text-xs text-gray-500 font-bold uppercase tracking-widest mb-3">
              {serviceType === 'delivery' ? 'Endereço Incompleto' : 'Telefone/WhatsApp em Falta'}
            </p>
            <button
              onClick={() => navigate('/profile')}
              className="bg-brand text-white px-5 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-brand-dark transition-colors"
            >
              Completar Dados do Perfil
            </button>
          </div>
        ) : (
          <div className="space-y-3.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-gray-50 p-3.5 rounded-lg border border-gray-100">
              <div className="flex items-center gap-2 text-gray-700">
                <UserIcon size={14} className="text-gray-400" />
                <span className="font-semibold">Cliente:</span>
                <span className="font-bold text-gray-900">{user?.name}</span>
              </div>
              <div className="flex items-center gap-2 text-gray-700">
                <Phone size={14} className="text-gray-400" />
                <span className="font-semibold">Contato (WhatsApp):</span>
                <span className="font-bold text-gray-900 font-mono">{user?.phone}</span>
              </div>
            </div>

            {serviceType === 'delivery' ? (
              <div className="bg-gray-50/50 p-4 rounded-lg border border-gray-100 space-y-2 text-xs">
                <div>
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Endereço de Entrega</span>
                  <p className="font-bold text-gray-800">
                    {user?.addressStreet}, Nº {user?.addressNumber}
                    {user?.addressComplement && ` - ${user?.addressComplement}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Bairro</span>
                    <p className="font-semibold text-gray-700">{user?.addressNeighborhood}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">CEP</span>
                    <p className="font-semibold text-gray-700 font-mono">{user?.addressZip}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Município</span>
                    <p className="font-semibold text-gray-700">{user?.addressCity}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Estado</span>
                    <p className="font-semibold text-gray-700 uppercase">{user?.addressState}</p>
                  </div>
                </div>
                {user?.addressReference && (
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Ponto de Referência</span>
                    <p className="text-gray-600 font-medium italic">{user?.addressReference}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-50/50 p-4 rounded-lg border border-gray-100 text-xs">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">Local do Estabelecimento</span>
                <p className="font-bold text-gray-800">{companyInfo?.address || 'Av. Euclídes da Cunha, 800 - Loja 1'}</p>
              </div>
            )}
          </div>
        )}

      </div>

      {/* Observações do Pedido */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-100 p-5 mb-6">
        <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-50 pb-3">
          <MessageSquare size={14} className="text-brand" /> Observações do Pedido
        </h3>
        <div>
          <label className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">
            Alguma informação ou instrução importante sobre o seu pedido?
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ex: sem cebola, sem farofa, troco para R$ 50, campainha com defeito..."
            maxLength={300}
            rows={3}
            className="w-full border border-gray-200 bg-gray-50 rounded-lg py-2 px-3 text-xs text-gray-800 placeholder:text-gray-400 focus:ring-brand focus:border-brand focus:outline-none font-medium resize-none"
          />
          <div className="flex justify-end mt-1">
            <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider">
              {notes.length}/300 caracteres
            </span>
          </div>
        </div>
      </div>

      {/* Fidelidade */}
      {companyInfo?.loyaltyEnabled && (
        <div className="bg-white shadow-sm rounded-xl border border-gray-100 p-5 mb-6">
          <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-50 pb-3">
            <Gift size={14} className="text-brand" /> Fidelidade
          </h3>
          <div className="flex items-center justify-between mb-4 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
            <span className="text-xs font-bold text-amber-900 flex items-center gap-2">
              <Star size={14} className="text-amber-500 fill-amber-500" /> Seus pontos
            </span>
            <span className="text-sm font-black text-amber-900">{userPoints} pts</span>
          </div>
          {availableRewards.length > 0 ? (
            <div className="space-y-2">
              {availableRewards.map(reward => {
                const affordable = userPoints >= reward.pointsCost;
                const isSelected = selectedRewardId === reward.id;
                const isBest = affordable && reward.id === bestRewardId;
                return (
                  <button
                    key={reward.id}
                    type="button"
                    disabled={!affordable}
                    onClick={() => setSelectedRewardId(isSelected ? null : reward.id)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                      isSelected ? 'border-brand bg-brand/5' : isBest ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-black text-gray-900">{reward.label}</p>
                        {isBest && (
                          <span className="inline-flex items-center gap-1 bg-amber-400 text-amber-950 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full">
                            <Star size={9} className="fill-amber-950" /> Melhor oferta
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mt-0.5">{reward.pointsCost} pts</p>
                    </div>
                    {isSelected && <Check size={16} className="text-brand shrink-0" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-400 font-bold">Nenhuma recompensa disponível no momento.</p>
          )}
        </div>
      )}

      {/* Forma de Pagamento */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-100 p-5 mb-6">
        <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-50 pb-3">
          <CreditCard size={14} className="text-brand" /> Forma de Pagamento
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => setPaymentMethod('pix')}
            className={`p-4 rounded-xl border-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
              paymentMethod === 'pix'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <QrCode size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider">PIX</span>
          </button>
          
          <button
            type="button"
            onClick={() => {
              setPaymentMethod('credit');
              setNeedChange(null);
            }}
            className={`p-4 rounded-xl border-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
              paymentMethod === 'credit'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <CreditCard size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Crédito</span>
          </button>
          
          <button
            type="button"
            onClick={() => {
              setPaymentMethod('debit');
              setNeedChange(null);
            }}
            className={`p-4 rounded-xl border-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
              paymentMethod === 'debit'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <CreditCard size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Débito</span>
          </button>
          
          <button
            type="button"
            onClick={() => {
              setPaymentMethod('cash');
              setNeedChange(null);
            }}
            className={`p-4 rounded-xl border-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
              paymentMethod === 'cash'
                ? 'border-brand bg-brand/5 text-brand shadow-sm shadow-brand/10'
                : 'border-gray-100 hover:border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <DollarSign size={20} />
            <span className="text-[10px] font-black uppercase tracking-wider text-center">Dinheiro</span>
          </button>
        </div>

        {paymentMethod === 'pix' && (
          <p className="text-[10px] text-gray-400 mt-4 text-center font-bold uppercase tracking-wider">
            Você receberá as instruções e a chave PIX na próxima etapa para enviar o comprovante.
          </p>
        )}

        {(paymentMethod === 'credit' || paymentMethod === 'debit') && (
          <p className="text-[10px] text-gray-400 mt-4 text-center font-bold uppercase tracking-wider">
            O entregador levará a maquininha de cartão até o seu endereço para realizar a cobrança.
          </p>
        )}

        {paymentMethod === 'cash' && (
          <div className="mt-4 p-4 bg-gray-50 rounded-xl border border-gray-100 space-y-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Precisa de Troco?</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setNeedChange(true)}
                className={`flex-1 py-2 px-4 rounded-lg border text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                  needChange === true
                    ? 'bg-brand text-white border-brand shadow-sm'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                Sim
              </button>
              <button
                type="button"
                onClick={() => {
                  setNeedChange(false);
                  setChangeFor('');
                }}
                className={`flex-1 py-2 px-4 rounded-lg border text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                  needChange === false
                    ? 'bg-brand text-white border-brand shadow-sm'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                Não (Valor Exato)
              </button>
            </div>

            {needChange === true && (
              <div className="space-y-1.5">
                <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 block">
                  Troco para quanto?
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400">R$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={changeFor}
                    onChange={(e) => setChangeFor(e.target.value.replace(/[^0-9,.]/g, ''))}
                    placeholder="Ex: 50,00"
                    className="w-full pl-9 pr-3 py-2 border border-gray-200 focus:border-brand focus:ring-brand rounded-lg text-xs font-bold bg-white"
                  />
                </div>
                {changeFor && parseFloat(changeFor.replace(',', '.')) <= displayFinalTotal && (
                  <p className="text-[9px] text-red-500 font-bold uppercase tracking-wider">
                    O valor para o troco deve ser maior que o total do pedido ({formatCurrency(displayFinalTotal)}).
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {(() => {
        const status = isStoreOpen(companyInfo);
        const closedBlock = !status.isOpen && user?.role !== 'admin';
        return (
          <>
            {closedBlock && (
              <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex items-start gap-3 shadow-xs animate-pulse">
                <div className="p-2 bg-amber-100 text-amber-700 rounded-lg shrink-0 mt-0.5">
                  <AlertCircle size={18} />
                </div>
                <div>
                  <h3 className="text-xs font-black uppercase tracking-wider text-amber-950">Aviso: Estabelecimento Fechado</h3>
                  <p className="text-xs font-bold mt-1 text-amber-850 leading-relaxed">{status.reason}</p>
                  <p className="text-[10px] uppercase font-black tracking-widest text-amber-600 mt-2">Os pedidos estão temporariamente indisponíveis devido ao horário de funcionamento.</p>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleCheckout}
                disabled={
                  loading || 
                  closedBlock ||
                  isProfileIncomplete || 
                  (paymentMethod === 'cash' && needChange === null) ||
                  (paymentMethod === 'cash' && needChange === true && (!changeFor.trim() || parseFloat(changeFor.replace(',', '.')) <= displayFinalTotal))
                }
                className="w-full sm:w-auto bg-brand text-white px-8 py-3 rounded-lg font-bold text-xs uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm cursor-pointer"
              >
                {loading ? 'Processando...' : 'Finalizar Pedido'}
              </button>
            </div>
          </>
        );
      })()}

      {/* Floating Animated Toast Alert */}
      <AnimatePresence>
        {alertState && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: 20, scale: 0.9, x: '-50%' }}
            className="fixed bottom-6 left-1/2 z-50 w-full max-w-xs px-4"
          >
            <div className={`rounded-xl shadow-xl border p-4 flex items-center gap-3 ${
              alertState.type === 'success' 
                ? "bg-emerald-50 border-emerald-200 text-emerald-800" 
                : alertState.type === 'warning'
                ? "bg-amber-50 border-amber-200 text-amber-800"
                : "bg-rose-50 border-rose-200 text-rose-800"
            }`}>
              {alertState.type === 'success' ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center shrink-0 text-white shadow-sm shadow-emerald-500/20">
                  <Check size={18} className="stroke-[3]" />
                </div>
              ) : alertState.type === 'warning' ? (
                <div className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center shrink-0 text-white shadow-sm shadow-amber-500/20">
                  <AlertCircle size={18} className="stroke-[3]" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-rose-500 flex items-center justify-center shrink-0 text-white shadow-sm shadow-rose-500/20">
                  <X size={18} className="stroke-[3]" />
                </div>
              )}
              <div className="flex-1">
                <p className="text-xs font-black uppercase tracking-wider leading-tight">
                  {alertState.message}
                </p>
                {alertState.submessage && (
                  <p className="text-[10px] opacity-90 mt-0.5 leading-none font-medium">
                    {alertState.submessage}
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editingItemIndex !== null && items[editingItemIndex] && (
          <ProductModal
            product={items[editingItemIndex].product}
            onClose={() => setEditingItemIndex(null)}
            editItemIndex={editingItemIndex}
            existingItem={items[editingItemIndex]}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
